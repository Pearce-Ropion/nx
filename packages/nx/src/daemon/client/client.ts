import { workspaceRoot } from '../../utils/workspace-root';
import { ChildProcess, spawn, spawnSync } from 'child_process';
import { openSync, readFileSync, statSync } from 'fs';
import { ensureDirSync, ensureFileSync } from 'fs-extra';
import { connect } from 'net';
import { join } from 'path';
import { performance } from 'perf_hooks';
import { output } from '../../utils/output';
import {
  safelyCleanUpExistingProcess,
  writeDaemonJsonProcessCache,
} from '../cache';
import { FULL_OS_SOCKET_PATH, killSocketOrPath } from '../socket-utils';
import {
  DAEMON_DIR_FOR_CURRENT_WORKSPACE,
  DAEMON_OUTPUT_LOG_FILE,
  isDaemonDisabled,
} from '../tmp-dir';
import { ProjectGraph } from '../../config/project-graph';
import { isCI } from '../../utils/is-ci';
import { readNxJson } from '../../config/configuration';
import { NxJsonConfiguration } from 'nx/src/config/nx-json';

const DAEMON_ENV_SETTINGS = {
  ...process.env,
  NX_PROJECT_GLOB_CACHE: 'false',
  NX_CACHE_WORKSPACE_CONFIG: 'false',
};

export class DaemonClient {
  constructor(private readonly nxJson: NxJsonConfiguration) {}

  enabled() {
    const useDaemonProcessOption =
      this.nxJson.tasksRunnerOptions?.['default']?.options?.useDaemonProcess;
    const env = process.env.NX_DAEMON;

    // env takes precedence
    // option=true,env=false => no daemon
    // option=false,env=undefined => no daemon
    // option=false,env=false => no daemon

    // option=undefined,env=undefined => daemon
    // option=true,env=true => daemon
    // option=false,env=true => daemon
    if (
      isCI() ||
      isDocker() ||
      isDaemonDisabled() ||
      (useDaemonProcessOption === undefined && env === 'false') ||
      (useDaemonProcessOption === true && env === 'false') ||
      (useDaemonProcessOption === false && env === undefined) ||
      (useDaemonProcessOption === false && env === 'false')
    ) {
      return false;
    }
    return true;
  }

  async getProjectGraph(): Promise<ProjectGraph> {
    if (!(await isServerAvailable())) {
      await startInBackground();
    }
    return sendMessageToDaemon({ type: 'REQUEST_PROJECT_GRAPH' });
  }

  async processInBackground(requirePath: string, data: any): Promise<any> {
    if (!(await isServerAvailable())) {
      await startInBackground();
    }
    return sendMessageToDaemon({
      type: 'PROCESS_IN_BACKGROUND',
      requirePath,
      data,
    });
  }
}

function isDocker() {
  try {
    statSync('/.dockerenv');
    return true;
  } catch {
    return false;
  }
}

export async function startInBackground(): Promise<ChildProcess['pid']> {
  await safelyCleanUpExistingProcess();
  ensureDirSync(DAEMON_DIR_FOR_CURRENT_WORKSPACE);
  ensureFileSync(DAEMON_OUTPUT_LOG_FILE);

  const out = openSync(DAEMON_OUTPUT_LOG_FILE, 'a');
  const err = openSync(DAEMON_OUTPUT_LOG_FILE, 'a');
  const backgroundProcess = spawn(
    process.execPath,
    [join(__dirname, '../server/start.js')],
    {
      cwd: workspaceRoot,
      stdio: ['ignore', out, err],
      detached: true,
      windowsHide: true,
      shell: false,
      env: DAEMON_ENV_SETTINGS,
    }
  );
  backgroundProcess.unref();

  // Persist metadata about the background process so that it can be cleaned up later if needed
  await writeDaemonJsonProcessCache({
    processId: backgroundProcess.pid,
  });

  /**
   * Ensure the server is actually available to connect to via IPC before resolving
   */
  let attempts = 0;
  return new Promise((resolve, reject) => {
    const id = setInterval(async () => {
      if (await isServerAvailable()) {
        clearInterval(id);
        resolve(backgroundProcess.pid);
      } else if (attempts > 200) {
        // daemon fails to start, the process probably exited
        // we print the logs and exit the client
        reject(
          daemonProcessException('Failed to start the Nx Daemon process.')
        );
      } else {
        attempts++;
      }
    }, 10);
  });
}

function daemonProcessException(message: string) {
  try {
    let log = readFileSync(DAEMON_OUTPUT_LOG_FILE).toString().split('\n');
    if (log.length > 20) {
      log = log.slice(log.length - 20);
    }
    return new Error(
      [
        message,
        'Messages from the log:',
        ...log,
        '\n',
        `More information: ${DAEMON_OUTPUT_LOG_FILE}`,
      ].join('\n')
    );
  } catch (e) {
    return new Error(message);
  }
}

export function startInCurrentProcess(): void {
  output.log({
    title: `Daemon Server - Starting in the current process...`,
  });

  spawnSync(process.execPath, [join(__dirname, '../server/start.js')], {
    cwd: workspaceRoot,
    stdio: 'inherit',
    env: DAEMON_ENV_SETTINGS,
  });
}

export function stop(): void {
  spawnSync(process.execPath, ['../server/stop.js'], {
    cwd: __dirname,
    stdio: 'inherit',
  });

  output.log({ title: 'Daemon Server - Stopped' });
}

/**
 * As noted in the comments above the createServer() call, in order to reliably (meaning it works
 * cross-platform) check whether the server is available to request a project graph from we
 * need to actually attempt connecting to it.
 *
 * Because of the behavior of named pipes on Windows, we cannot simply treat them as a file and
 * check for their existence on disk (unlike with Unix Sockets).
 */
export async function isServerAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const socket = connect(FULL_OS_SOCKET_PATH, () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => {
        resolve(false);
      });
    } catch (err) {
      resolve(false);
    }
  });
}

async function sendMessageToDaemon(message: {
  type: string;
  requirePath?: string;
  data?: any;
}): Promise<any> {
  return new Promise((resolve, reject) => {
    performance.mark('sendMessageToDaemon-start');
    const socket = connect(FULL_OS_SOCKET_PATH);

    socket.on('error', (err) => {
      if (!err.message) {
        return reject(err);
      }
      if (err.message.startsWith('LOCK-FILES-CHANGED')) {
        return sendMessageToDaemon(message).then(resolve, reject);
      }
      let error: any;
      if (err.message.startsWith('connect ENOENT')) {
        error = daemonProcessException('The Daemon Server is not running');
      } else if (err.message.startsWith('connect ECONNREFUSED')) {
        error = daemonProcessException(
          `A server instance had not been fully shut down. Please try running the command again.`
        );
        killSocketOrPath();
      } else if (err.message.startsWith('read ECONNRESET')) {
        error = daemonProcessException(
          `Unable to connect to the daemon process.`
        );
      }
      return reject(error || err);
    });

    socket.on('connect', () => {
      socket.write(JSON.stringify(message));

      let serializedResult = '';
      socket.on('data', (data) => {
        serializedResult += data.toString();
      });

      socket.on('end', () => {
        try {
          performance.mark('json-parse-start');
          const parsedResult = JSON.parse(serializedResult);
          performance.mark('json-parse-end');
          performance.measure(
            'deserialize daemon response',
            'json-parse-start',
            'json-parse-end'
          );
          if (parsedResult.error) {
            reject(parsedResult.error);
          } else {
            performance.measure(
              'total for sendMessageToDaemon()',
              'sendMessageToDaemon-start',
              'json-parse-end'
            );
            return resolve(parsedResult.projectGraph);
          }
        } catch (e) {
          const endOfResponse =
            serializedResult.length > 300
              ? serializedResult.substring(serializedResult.length - 300)
              : serializedResult;
          reject(
            daemonProcessException(
              [
                'Could not deserialize response from Nx deamon.',
                `Message: ${e.message}`,
                '\n',
                `Received:`,
                endOfResponse,
                '\n',
              ].join('\n')
            )
          );
        }
      });
    });
  });
}
