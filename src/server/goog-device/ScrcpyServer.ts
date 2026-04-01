import '../../../vendor/Genymobile/scrcpy/scrcpy-server.jar';
import '../../../vendor/Genymobile/scrcpy/LICENSE';
 
import { Device } from './Device';
import { ARGS_STRING, SERVER_PACKAGE, SERVER_PROCESS_NAME, SERVER_VERSION } from '../../common/Constants';
import path from 'path';
import PushTransfer from '@dead50f7/adbkit/lib/adb/sync/pushtransfer';
import { ServerVersion } from './ServerVersion';
 
const TEMP_PATH = '/data/local/tmp/';
const FILE_DIR = path.join(__dirname, 'vendor/Genymobile/scrcpy');
const FILE_NAME = 'scrcpy-server.jar';
const RUN_COMMAND = `CLASSPATH=${TEMP_PATH}${FILE_NAME} app_process ${ARGS_STRING}`;
 
type WaitForPidParams = { tryCounter: number; processExited: boolean };
 
export class ScrcpyServer {
    private static async copyServer(device: Device): Promise<PushTransfer> {
        const src = path.join(FILE_DIR, FILE_NAME);
        const dst = TEMP_PATH + FILE_NAME;
        console.log(device.TAG, `[ScrcpyServer] Pushing JAR from: ${src} → ${dst}`);
        return device.push(src, dst);
    }
 
    private static async waitForServerPid(device: Device, params: WaitForPidParams): Promise<number[] | undefined> {
        const { tryCounter, processExited } = params;
        if (processExited) {
            return;
        }
        const timeout = 500 + 100 * tryCounter;
 
        const list = await this.getServerPid(device);
        if (Array.isArray(list) && list.length) {
            return list;
        }
 
        if (++params.tryCounter > 10) {
            throw new Error('Failed to start server');
        }
        return new Promise<number[] | undefined>((resolve) => {
            setTimeout(() => {
                resolve(this.waitForServerPid(device, params));
            }, timeout);
        });
    }
 
    public static async getServerPid(device: Device): Promise<number[] | undefined> {
        if (!device.isConnected()) {
            return;
        }
        const list = await device.getPidOf(SERVER_PROCESS_NAME);
        if (!Array.isArray(list) || !list.length) {
            return;
        }
        const serverPid: number[] = [];
        const promises = list.map((pid) => {
            return device.runShellCommandAdbKit(`cat /proc/${pid}/cmdline`).then((output) => {
                const args = output.split('\0');
                if (!args.length || args[0] !== SERVER_PROCESS_NAME) {
                    return;
                }
                let first = args[0];
                while (args.length && first !== SERVER_PACKAGE) {
                    args.shift();
                    first = args[0];
                }
                if (args.length < 3) {
                    return;
                }
                const versionString = args[1];
                console.log(device.TAG, `[ScrcpyServer] Found process PID:${pid} version:${versionString}`);
                if (versionString === SERVER_VERSION) {
                    serverPid.push(pid);
                } else {
                    const currentVersion = new ServerVersion(versionString);
                    if (currentVersion.isCompatible()) {
                        const desired = new ServerVersion(SERVER_VERSION);
                        if (desired.gt(currentVersion)) {
                            console.log(
                                device.TAG,
                                `Found old server version running (PID: ${pid}, Version: ${versionString})`,
                            );
                            console.log(device.TAG, 'Perform kill now');
                            device.killProcess(pid);
                        }
                    }
                }
                return;
            });
        });
        await Promise.all(promises);
        return serverPid;
    }
 
    public static async run(device: Device): Promise<number[] | undefined> {
        if (!device.isConnected()) {
            return;
        }
        let list: number[] | string | undefined = await this.getServerPid(device);
        if (Array.isArray(list) && list.length) {
            return list;
        }
 
        await this.copyServer(device);
        console.log(device.TAG, `[ScrcpyServer] Launching: ${RUN_COMMAND}`);
 
        const params: WaitForPidParams = { tryCounter: 0, processExited: false };
        const runPromise = device.runShellCommandAdb(RUN_COMMAND);
        runPromise
            .then((out) => {
                if (device.isConnected()) {
                    console.log(device.TAG, 'Server exited:', out);
                }
            })
            .catch((e) => {
                console.log(device.TAG, 'Error:', e.message);
            })
            .finally(() => {
                params.processExited = true;
            });
        list = await Promise.race([runPromise, this.waitForServerPid(device, params)]);
        if (Array.isArray(list) && list.length) {
            return list;
        }
        return;
    }
}