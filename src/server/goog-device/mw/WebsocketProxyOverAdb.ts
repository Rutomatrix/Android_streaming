import { WebsocketProxy } from '../../mw/WebsocketProxy';
import { AdbUtils } from '../AdbUtils';
import WS from 'ws';
import net from 'net';
import { RequestParameters } from '../../mw/Mw';
import { ACTION } from '../../../common/Action';
import { ScrcpyStreamBridge } from './ScrcpyStreamBridge';
 
export class WebsocketProxyOverAdb extends WebsocketProxy {
    public static processRequest(ws: WS, params: RequestParameters): WebsocketProxy | undefined {
        const { action, url } = params;
        let udid: string | null = '';
        let remote: string | null = '';
        let isSuitable = false;
        if (action === ACTION.PROXY_ADB) {
            isSuitable = true;
            remote = url.searchParams.get('remote');
            udid = url.searchParams.get('udid');
        }
        if (url && url.pathname) {
            const temp = url.pathname.split('/');
            if (temp.length >= 4 && temp[0] === '' && temp[1] === ACTION.PROXY_ADB) {
                isSuitable = true;
                temp.splice(0, 2);
                udid = decodeURIComponent(temp.shift() || '');
                remote = decodeURIComponent(temp.shift() || '');
            }
        }
        if (!isSuitable) return;
        if (typeof remote !== 'string' || !remote) {
            ws.close(4003, `[${this.TAG}] Invalid remote: "${remote}"`);
            return;
        }
        if (typeof udid !== 'string' || !udid) {
            ws.close(4003, `[${this.TAG}] Invalid udid: "${udid}"`);
            return;
        }
        return this.createProxyOverAdb(ws, udid, remote);
    }
 
    public static createProxyOverAdb(ws: WS, udid: string, remote: string): WebsocketProxy {

        const service = new WebsocketProxy(ws);

        AdbUtils.forward(udid, remote)

            .then((port) => {

                console.log(`[WebsocketProxyOverAdb] Forwarded ${remote} → tcp:${port}`);
    
                // Connection 1: video socket

                const videoSocket = net.createConnection({ host: '127.0.0.1', port }, () => {

                    console.log(`[WebsocketProxyOverAdb] Video socket connected`);
    
                    // Connection 2: control socket (must connect before server sends anything)

                    const controlSocket = net.createConnection({ host: '127.0.0.1', port }, () => {

                        console.log(`[WebsocketProxyOverAdb] Control socket connected`);

                        // Now bridge the video socket to the browser

                        new ScrcpyStreamBridge(ws, videoSocket, controlSocket);

                    });
    
                    controlSocket.on('error', (e) => {

                        console.error(`[WebsocketProxyOverAdb] Control socket error: ${e.message}`);

                        ws.close(4005, e.message);

                    });

                });
    
                videoSocket.on('error', (e) => {

                    const msg = `[${this.TAG}] Video socket error: ${e.message}`;

                    console.error(msg);

                    ws.close(4005, msg);

                });

            })

            .catch((e) => {

                const msg = `[${this.TAG}] Forward failed: ${e.message}`;

                console.error(msg);

                ws.close(4005, msg);

            });

        return service;

    }
 
}