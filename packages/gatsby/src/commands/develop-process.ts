import { syncStaticDir } from "../utils/get-static-dir"
import reporter from "gatsby-cli/lib/reporter"
import chalk from "chalk"
import telemetry from "gatsby-telemetry"
import express from "express"
import { initTracer } from "../utils/tracer"
import db from "../db"
import { detectPortInUseAndPrompt } from "../utils/detect-port-in-use-and-prompt"
import onExit from "signal-exit"
import {
  userPassesFeedbackRequestHeuristic,
  showFeedbackRequest,
} from "../utils/feedback"
import { startRedirectListener } from "../bootstrap/redirects-writer"
import { markWebpackStatusAsPending } from "../utils/webpack-status"

import { IProgram } from "./types"
import {
  IBuildContext,
  initialize,
  rebuildSchemaWithSitePage,
  writeOutRedirects,
  startWebpackServer,
} from "../services"
import { boundActionCreators } from "../redux/actions"
import { ProgramStatus } from "../redux/types"
import {
  MachineConfig,
  AnyEventObject,
  Machine,
  interpret,
  Actor,
  Interpreter,
  forwardTo,
  State,
  StateMachine,
} from "xstate"
import { stringify, machineToJSON } from "xstate/lib/json"
import { dataLayerMachine } from "../state-machines/data-layer"
import { IDataLayerContext } from "../state-machines/data-layer/types"
import { globalTracer } from "opentracing"
import { IQueryRunningContext } from "../state-machines/query-running/types"
import { queryRunningMachine } from "../state-machines/query-running"
import { IWaitingContext } from "../state-machines/waiting/types"
import { runMutationAndMarkDirty } from "../state-machines/shared-transition-configs"
import { buildActions } from "../state-machines/actions"
import { waitingMachine } from "../state-machines/waiting"
import { emitter } from "../redux"

const tracer = globalTracer()

// const isInteractive = process.stdout.isTTY

// Watch the static directory and copy files to public as they're added or
// changed. Wait 10 seconds so copying doesn't interfere with the regular
// bootstrap.
setTimeout(() => {
  syncStaticDir()
}, 10000)

// Time for another story...
// When the parent process is killed by SIGKILL, Node doesm't kill spawned child processes
// Hence, we peiodically send a heart beat to the parent to check if it is still alive
// This will crash with Error [ERR_IPC_CHANNEL_CLOSED]: Channel closed
// and kill the orphaned child process as a result
if (process.send) {
  setInterval(() => {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    process.send!({
      type: `HEARTBEAT`,
    })
  }, 1000)
}

onExit(() => {
  telemetry.trackCli(`DEVELOP_STOP`)
})

process.on(`message`, msg => {
  if (msg.type === `COMMAND` && msg.action.type === `EXIT`) {
    process.exit(msg.action.payload)
  }
})

module.exports = async (program: IProgram): Promise<void> => {
  reporter.setVerbose(program.verbose)
  const bootstrapSpan = tracer.startSpan(`bootstrap`)

  // We want to prompt the feedback request when users quit develop
  // assuming they pass the heuristic check to know they are a user
  // we want to request feedback from, and we're not annoying them.
  process.on(
    `SIGINT`,
    async (): Promise<void> => {
      if (await userPassesFeedbackRequestHeuristic()) {
        showFeedbackRequest()
      }
      process.exit(0)
    }
  )

  if (process.env.GATSBY_EXPERIMENTAL_PAGE_BUILD_ON_DATA_CHANGES) {
    reporter.panic(
      `The flag ${chalk.yellow(
        `GATSBY_EXPERIMENTAL_PAGE_BUILD_ON_DATA_CHANGES`
      )} is not available with ${chalk.cyan(
        `gatsby develop`
      )}, please retry using ${chalk.cyan(`gatsby build`)}`
    )
  }
  initTracer(program.openTracingConfigFile)
  markWebpackStatusAsPending()
  reporter.pendingActivity({ id: `webpack-develop` })
  telemetry.trackCli(`DEVELOP_START`)
  telemetry.startBackgroundUpdate()

  const port =
    typeof program.port === `string` ? parseInt(program.port, 10) : program.port

  try {
    program.port = await detectPortInUseAndPrompt(port)
  } catch (e) {
    if (e.message === `USER_REJECTED`) {
      process.exit(0)
    }

    throw e
  }

  const app = express()

  const developConfig: MachineConfig<IBuildContext, any, AnyEventObject> = {
    id: `build`,
    initial: `initializing`,
    states: {
      initializing: {
        on: {
          // Ignore mutation events because we'll be running everything anyway
          ADD_NODE_MUTATION: undefined,
          QUERY_FILE_CHANGED: undefined,
          WEBHOOK_RECEIVED: undefined,
        },
        invoke: {
          src: `initialize`,
          onDone: {
            target: `initializingDataLayer`,
            actions: [`assignStoreAndWorkerPool`, `spawnMutationListener`],
          },
        },
      },
      initializingDataLayer: {
        on: {
          ADD_NODE_MUTATION: runMutationAndMarkDirty,
          // Ignore, because we're about to extract them anyway
          QUERY_FILE_CHANGED: undefined,
        },
        invoke: {
          src: `initializeDataLayer`,
          data: ({
            parentSpan,
            store,
            firstRun,
            webhookBody,
          }: IBuildContext): IDataLayerContext => {
            return {
              parentSpan,
              store,
              firstRun,
              deferNodeMutation: true,
              webhookBody,
            }
          },
          onDone: {
            actions: [`assignServiceResult`, `clearWebhookBody`],
            target: `finishingBootstrap`,
          },
        },
      },
      finishingBootstrap: {
        on: {
          ADD_NODE_MUTATION: runMutationAndMarkDirty,
          // Ignore, because we're about to extract them anyway
          QUERY_FILE_CHANGED: undefined,
        },
        invoke: {
          src: async (): Promise<void> => {
            // These were previously in `bootstrap()` but are now
            // in part of the state machine that hasn't been added yet
            await rebuildSchemaWithSitePage({ parentSpan: bootstrapSpan })

            await writeOutRedirects({ parentSpan: bootstrapSpan })

            startRedirectListener()
            bootstrapSpan.finish()
          },
          onDone: {
            target: `runningQueries`,
          },
        },
      },
      runningQueries: {
        on: {
          QUERY_FILE_CHANGED: {
            actions: forwardTo(`run-queries`),
          },
        },
        invoke: {
          id: `run-queries`,
          src: `runQueries`,
          data: ({
            program,
            store,
            parentSpan,
            gatsbyNodeGraphQLFunction,
            graphqlRunner,
            websocketManager,
            firstRun,
          }: IBuildContext): IQueryRunningContext => {
            return {
              firstRun,
              program,
              store,
              parentSpan,
              gatsbyNodeGraphQLFunction,
              graphqlRunner,
              websocketManager,
            }
          },
          onDone: {
            target: `doingEverythingElse`,
          },
        },
      },
      doingEverythingElse: {
        invoke: {
          src: async (): Promise<void> => {
            // All the stuff that's not in the state machine yet

            boundActionCreators.setProgramStatus(
              ProgramStatus.BOOTSTRAP_QUERY_RUNNING_FINISHED
            )

            await db.saveState()

            db.startAutosave()
          },
          onDone: [
            {
              target: `startingDevServers`,
              cond: ({ compiler }: IBuildContext): boolean => !compiler,
            },
            {
              target: `waiting`,
            },
          ],
        },
      },
      startingDevServers: {
        invoke: {
          src: `startWebpackServer`,
          onDone: {
            target: `waiting`,
            actions: `assignServers`,
          },
        },
      },
      waiting: {
        on: {
          ADD_NODE_MUTATION: {
            actions: forwardTo(`waiting`),
          },
          QUERY_FILE_CHANGED: {
            actions: forwardTo(`waiting`),
          },
          EXTRACT_QUERIES_NOW: {
            target: `runningQueries`,
          },
        },
        invoke: {
          id: `waiting`,
          src: `waitForMutations`,
          data: ({
            store,
            nodeMutationBatch = [],
          }: IBuildContext): IWaitingContext => {
            return { store, nodeMutationBatch, runningBatch: [] }
          },
          onDone: {
            actions: `assignServiceResult`,
            target: `rebuildingPages`,
          },
        },
      },
      rebuildingPages: {
        invoke: {
          src: `initializeDataLayer`,
          data: ({ parentSpan, store }: IBuildContext): IDataLayerContext => {
            return { parentSpan, store, firstRun: false, skipSourcing: true }
          },
          onDone: {
            actions: `assignServiceResult`,
            target: `runningQueries`,
          },
        },
      },
    },
    // Transitions shared by all states, except where overridden
    on: {
      ADD_NODE_MUTATION: {
        actions: `addNodeMutation`,
      },
      QUERY_FILE_CHANGED: {
        actions: `markQueryFilesDirty`,
      },
      WEBHOOK_RECEIVED: {
        target: `initializingDataLayer`,
        actions: `assignWebhookBody`,
      },
    },
  }

  const machines = {
    initializeDataLayer: dataLayerMachine,
    runQueries: queryRunningMachine,
    waitForMutations: waitingMachine,
  }

  const machine = Machine(developConfig, {
    services: {
      ...machines,
      startWebpackServer: startWebpackServer,
      initialize,
    },
    actions: buildActions,
  }).withContext({ program, parentSpan: bootstrapSpan, app, firstRun: true })

  const service = interpret(machine)

  const isInterpreter = <T>(
    actor: Actor<T> | Interpreter<T>
  ): actor is Interpreter<T> => `machine` in actor

  const listeners = new WeakSet()
  let last: State<IBuildContext, AnyEventObject, any, any>

  function emitState(state: State<any>): void {
    console.log(JSON.stringify({ ...state, context: {} }))
    emitter.emit(`BUILD_STATE_CHANGED`, { value: service.state.value })
  }

  service.onTransition(state => {
    if (!last) {
      last = state
    } else if (!state.changed || last.matches(state)) {
      return
    }
    last = state
    emitState(state)
    reporter.verbose(`Transition to ${JSON.stringify(state.value)}`)
    // eslint-disable-next-line no-unused-expressions
    service.children?.forEach(child => {
      // We want to ensure we don't attach a listener to the same
      // actor. We don't need to worry about detaching the listener
      // because xstate handles that for us when the actor is stopped.

      if (isInterpreter(child) && !listeners.has(child)) {
        let sublast = child.state
        child.onTransition(substate => {
          if (!sublast) {
            sublast = substate
          } else if (!substate.changed || sublast.matches(substate)) {
            return
          }
          emitState(substate)

          sublast = substate
          reporter.verbose(
            `Transition to ${JSON.stringify(state.value)} > ${JSON.stringify(
              substate.value
            )}`
          )
        })
        listeners.add(child)
      }
    })
  })
  service.start()
  console.log(
    JSON.stringify({
      type: `service.register`,
      machine: JSON.stringify(machineToJSON(machine)),
      state: JSON.stringify(machine.initialState),
      id: machine.id,
    })
  )

  for (const id in machines) {
    const service = machines[id]
    console.log(
      JSON.stringify({
        type: `service.register`,
        machine: JSON.stringify(machineToJSON(service)),
        state: JSON.stringify(service.initialState),
        id: service.id,
        parent: machine.id,
      })
    )
  }
}
