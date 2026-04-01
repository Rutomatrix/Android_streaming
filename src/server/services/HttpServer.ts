import * as http from 'http';
import * as https from 'https';
import path from 'path';
import { Service } from './Service';
import { Utils } from '../Utils';
import express, { Express } from 'express';
import { Config } from '../Config';
import { TypedEmitter } from '../../common/TypedEmitter';

const DEFAULT_STATIC_DIR = path.join(__dirname, './public');

export type ServerAndPort = {
    server: https.Server | http.Server;
    port: number;
};

interface HttpServerEvents {
    started: boolean;
}

export class HttpServer extends TypedEmitter<HttpServerEvents> implements Service {
    private static instance: HttpServer;
    private static PUBLIC_DIR = DEFAULT_STATIC_DIR;
    private static SERVE_STATIC = true;
    private servers: ServerAndPort[] = [];
    private mainApp?: Express;
    private started = false;

    protected constructor() {
        super();
    }

    public static getInstance(): HttpServer {
        if (!this.instance) {
            this.instance = new HttpServer();
        }
        return this.instance;
    }

    public static hasInstance(): boolean {
        return !!this.instance;
    }

    public static setPublicDir(dir: string): void {
        if (HttpServer.instance) {
            throw Error('Unable to change value after instantiation');
        }
        HttpServer.PUBLIC_DIR = dir;
    }

    public static setServeStatic(enabled: boolean): void {
        if (HttpServer.instance) {
            throw Error('Unable to change value after instantiation');
        }
        HttpServer.SERVE_STATIC = enabled;
    }

    public async getServers(): Promise<ServerAndPort[]> {
        if (this.started) {
            return [...this.servers];
        }
        return new Promise<ServerAndPort[]>((resolve) => {
            this.once('started', () => {
                resolve([...this.servers]);
            });
        });
    }

    public getName(): string {
        return `HTTP(s) Server Service`;
    }

    public async start(): Promise<void> {
        this.mainApp = express();
        // ====== RECORDINGS API (insert inside HttpServer.start(), after `this.mainApp = express();`) ======
        try {
        // POST /api/recordings  -> save recording (body: { name, data })
        // this.mainApp!.post('/api/recordings', express.json(), (req, res) => {
        //     try {
        //     const body = req.body;
        //     if (!body || !body.name || !Array.isArray(body.data)) {
        //         res.status(400).json({ ok: false, error: 'Invalid payload' });
        //         return;
        //     }
        //     // lazy import to avoid circular issues
        //     const recordingDir = '/home/rpi/Desktop/ws-scrcpy-0.8.1/dist/recordings';
        //     const { RecordingService } = require('./RecordingService');
        //     const result = RecordingService.saveRecording(body.name, body.data);
        //     if (result.ok) {
        //         res.json({ ok: true, path: result.path });
        //     } else {
        //         res.status(500).json({ ok: false, error: result.error });
        //     }
        //     } catch (err: any) {
        //     res.status(500).json({ ok: false, error: String(err) });
        //     }
        // });


        // GET /api/recordings -> list files
        // ====== OPTIONAL: Also add debugging to /api/recordings (SAVE) endpoint ======

        // Replace existing POST /api/recordings with this debug version:

        this.mainApp!.post('/api/recordings', express.json(), (req, res) => {
        try {
            const body = req.body;
            if (!body || !body.name || !Array.isArray(body.data)) {
            res.status(400).json({ ok: false, error: 'Invalid payload' });
            return;
            }

            // ✅ FIXED PATH - Save to dist/recordings
            const recordingDir = '/home/rpi/Desktop/ws-scrcpy-0.8.1/dist/recordings';
            const { RecordingService } = require('./RecordingService');
            
            // Pass correct directory to RecordingService
            const result = RecordingService.saveRecording(body.name, body.data, recordingDir);
            
            console.log('\n' + '='.repeat(60));
            console.log('[RECORD] 📹 Saved to:', result.path);
            
            if (result.ok) {
            res.json({ ok: true, path: result.path });
            } else {
            res.status(500).json({ ok: false, error: result.error });
            }
            
        } catch (err: any) {
            res.status(500).json({ ok: false, error: String(err) });
        }
        });

        // GET /api/recordings -> list files
        this.mainApp!.get('/api/recordings', (_req, res) => {
        try {
            const { RecordingService } = require('./RecordingService');
            const result = RecordingService.listRecordings();
        
            console.log('[HTTP] /api/recordings ->', result);
        
            if (result.ok) {
            res.json(result);          // { ok: true, recordings: [...] }
            } else {
            res.status(500).json(result);
            }
        } catch (err: any) {
            console.error('[HTTP] listRecordings endpoint error', err);
            res.status(500).json({ ok: false, error: String(err) });
        }
        });

 
        // POST /api/recordings/play -> play by name (body: { name, mode? })
        this.mainApp!.post('/api/recordings/play', express.json(), async (req, res) => {
        try {
            const body = req.body;
            if (!body || !body.name) {
            res.status(400).json({ ok: false, error: 'Missing name' });
            return;
            }

            console.log('\n' + '='.repeat(60));
            console.log('[PLAY] 🎬 Starting replay of recording:', body.name);
            console.log('[PLAY] DelayMs:', body.delayMs || 120);
            console.log('='.repeat(60));

            const { RecordingService } = require('./RecordingService');
            
            // ✅ FIXED PATH - Use absolute dist/recordings path
            const recordingDir = '/home/rpi/Desktop/ws-scrcpy-0.8.1/dist/recordings';
            const filePath = `${recordingDir}/${body.name}`;
            
            // Read recording file to show what will be executed
            const fs = require('fs');
            try {
            const fileContent = fs.readFileSync(filePath, 'utf-8');
            const recordingData = JSON.parse(fileContent);
            
            console.log('\n[PLAY] 📋 Recording contains', recordingData.length, 'events:');
            console.log('[PLAY] '.padEnd(40, '-'));
            
            recordingData.forEach((event: any, index: number) => {
                if (event.adb) {
                console.log(`[PLAY] Event ${index + 1}: ${event.adb}`);
                } else {
                console.log(`[PLAY] Event ${index + 1}: ${event.type} (no adb command)`);
                }
            });
            
            console.log('[PLAY] '.padEnd(40, '-'));
            console.log('\n[PLAY] ⏳ Executing commands on device...\n');
            } catch (e) {
            console.warn('[PLAY] Could not read recording file:', (e as any).message);
            console.log('[PLAY] File path checked:', filePath);
            }

            // Execute with correct path passed to RecordingService
            const result = await RecordingService.replayByAdb(body.name, { 
            delayMs: 1000,
            // delayMs: 500,
            recordingDir: recordingDir  // ← Pass correct directory
            });
            
            console.log('\n' + '='.repeat(60));
            if (result.ok) {
            console.log('[PLAY] ✅ REPLAY COMPLETED SUCCESSFULLY');
            res.json({ ok: true });
            } else {
            console.log('[PLAY] ❌ REPLAY FAILED:', result.error);
            res.status(500).json({ ok: false, error: result.error });
            }
            console.log('='.repeat(60) + '\n');
            
        } catch (err: any) {
            console.error('[PLAY] 🔴 Endpoint error:', err.message);
            res.status(500).json({ ok: false, error: String(err) });
        }
        });
 

        } catch (err) {
            console.warn('[HTTPServer] failed to install recordings routes', err);
        }

        // POST /api/device-resolution -> get device resolution via adb shell wm size
        this.mainApp!.post('/api/device-resolution', express.json(), async (req, res) => {
            try {
            const body = req.body;
            if (!body || !body.udid) {
                res.status(400).json({ ok: false, error: 'Missing UDID' });
                return;
            }

            const udid = String(body.udid).trim();

            // Execute: adb -s <UDID> shell wm size
            const { exec } = require('child_process');
            let resolved = false;

            exec(`adb -s ${udid} shell wm size`, { timeout: 5000 }, (err: any, stdout: string, _stderr: string) => {

                if (resolved) return;

                resolved = true;
            
                if (err) {

                    console.warn('[HttpServer] Failed to get device resolution for', udid, err);

                    res.status(500).json({ ok: false, error: 'ADB command failed: ' + String(err) });

                    return;

                }
            
                try {

                    // 1) Parse physical size

                    const match = stdout.match(/Physical size:\s*(\d+)x(\d+)/);

                    if (!match || !match[1] || !match[2]) {

                        console.warn('[HttpServer] Could not parse device resolution from:', stdout);

                        res.status(400).json({ ok: false, error: 'Could not parse resolution from adb output' });

                        return;

                    }
            
                    const physicalWidth = parseInt(match[1], 10);

                    const physicalHeight = parseInt(match[2], 10);
            
                    // 2) Now get SurfaceOrientation (0–3)

                    exec(

                        `adb -s ${udid} shell dumpsys input | grep 'SurfaceOrientation'`,

                        { timeout: 5000 },

                        (rotErr: any, rotStdout: string, _rotStderr: string) => {

                            if (rotErr) {

                                console.warn('[HttpServer] Failed to get SurfaceOrientation for', udid, rotErr);

                                // Fallback: no rotation info -> just use physical

                                console.log(

                                    `[HttpServer] Device ${udid} resolution (no rotation info): ${physicalWidth}x${physicalHeight}`,

                                );

                                res.json({

                                    ok: true,

                                    width: physicalWidth,

                                    height: physicalHeight,

                                    rotation: null,

                                    physicalWidth,

                                    physicalHeight,

                                });

                                return;

                            }
            
                            let rotation = 0;

                            const rotMatch = rotStdout.match(/SurfaceOrientation:\s*(\d+)/);

                            if (rotMatch && rotMatch[1]) {

                                rotation = parseInt(rotMatch[1], 10);

                            }
            
                            // 3) Decide effective width/height based on orientation

                            // Portrait (0,2): width = 1080, height = 2400

                            // Landscape (1,3): width = 2400, height = 1080 (swap)

                            let width = physicalWidth;

                            let height = physicalHeight;
            
                            const isLandscape = rotation === 1 || rotation === 3;

                            if (isLandscape) {

                                width = physicalHeight;

                                height = physicalWidth;

                            }
            
                            console.log(

                                `[HttpServer] Device ${udid} physical=${physicalWidth}x${physicalHeight}, rotation=${rotation}, effective=${width}x${height}`,

                            );
            
                            res.json({

                                ok: true,

                                width,          // orientation-aware width

                                height,         // orientation-aware height

                                rotation,       // 0–3 (0,2 portrait; 1,3 landscape)

                                physicalWidth,  // original from wm size

                                physicalHeight,

                            });

                        },

                    );

                } catch (parseErr: any) {

                    console.error('[HttpServer] Error parsing device resolution', parseErr);

                    res.status(500).json({ ok: false, error: 'Parse error: ' + String(parseErr) });

                }

            });

            
            // Timeout fallback (just in case)
            setTimeout(() => {
                if (!resolved) {
                resolved = true;
                res.status(500).json({ ok: false, error: 'ADB command timeout' });
                }
            }, 6000);
            } catch (err: any) {
            console.error('[HttpServer] device-resolution endpoint error', err);
            res.status(500).json({ ok: false, error: String(err) });
            }
        });

        console.log('[HttpServer] Device info endpoints registered');

        // ====== END DEVICE INFO API ======


        if (HttpServer.SERVE_STATIC && HttpServer.PUBLIC_DIR) {
            this.mainApp.use(express.static(HttpServer.PUBLIC_DIR));

            /// #if USE_WDA_MJPEG_SERVER

            const { MjpegProxyFactory } = await import('../mw/MjpegProxyFactory');
            this.mainApp.get('/mjpeg/:udid', new MjpegProxyFactory().proxyRequest);
            /// #endif
        }
        const config = Config.getInstance();
        config.servers.forEach((serverItem) => {
            const { secure, port, redirectToSecure } = serverItem;
            let proto: string;
            let server: http.Server | https.Server;
            if (secure) {
                if (!serverItem.options) {
                    throw Error('Must provide option for secure server configuration');
                }
                server = https.createServer(serverItem.options, this.mainApp);
                proto = 'https';
            } else {
                const options = serverItem.options ? { ...serverItem.options } : {};
                proto = 'http';
                let currentApp = this.mainApp;
                let host = '';
                let port = 443;
                let doRedirect = false;
                if (redirectToSecure === true) {
                    doRedirect = true;
                } else if (typeof redirectToSecure === 'object') {
                    doRedirect = true;
                    if (typeof redirectToSecure.port === 'number') {
                        port = redirectToSecure.port;
                    }
                    if (typeof redirectToSecure.host === 'string') {
                        host = redirectToSecure.host;
                    }
                }
                if (doRedirect) {
                    currentApp = express();
                    currentApp.use(function (req, res) {
                        const url = new URL(`https://${host ? host : req.headers.host}${req.url}`);
                        if (port && port !== 443) {
                            url.port = port.toString();
                        }
                        return res.redirect(301, url.toString());
                    });
                }
                server = http.createServer(options, currentApp);
            }
            this.servers.push({ server, port });
            server.listen(port, () => {
                Utils.printListeningMsg(proto, port);
            });
        });
        this.started = true;
        this.emit('started', true);
    }

    public release(): void {
        this.servers.forEach((item) => {
            item.server.close();
        });
    }
}
