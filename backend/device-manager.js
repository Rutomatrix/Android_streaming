// device-manager.js
// Manages device tracking, streaming sessions, and scrcpy processes
// Enhanced: adaptive JPEG streaming, lower latency, orientation detection

const { spawn } = require('child_process');
const EventEmitter = require('events');
const adb = require('./adb-controller');

class DeviceManager extends EventEmitter {
  constructor() {
    super();
    this.devices = new Map();           // deviceId -> device info
    this.streamingSessions = new Map(); // deviceId -> scrcpy process
    this.rawStreams = new Map();        // wsId -> { stop }
    this.pollInterval = null;
    this.adbPath = process.env.ADB_PATH || 'adb';
    this.scrcpyPath = process.env.SCRCPY_PATH || 'scrcpy';
  }

  startPolling(intervalMs = 3000) {
    this.pollInterval = setInterval(() => this.refreshDevices(), intervalMs);
    this.refreshDevices();
  }

  stopPolling() {
    if (this.pollInterval) clearInterval(this.pollInterval);
  }

  async refreshDevices() {
    try {
      const deviceList = await adb.getDevices();
      const currentIds = new Set(deviceList.map(d => d.id));
      const previousIds = new Set(this.devices.keys());

      for (const device of deviceList) {
        if (!previousIds.has(device.id)) {
          if (device.state === 'device') {
            try {
              const info = await adb.getFullDeviceInfo(device.id);
              device.info = info;
            } catch (e) {
              device.info = {};
            }
          }
          this.devices.set(device.id, device);
          this.emit('deviceConnected', device);
          console.log(`[DeviceManager] Device connected: ${device.id} (${device.model})`);
        } else {
          const existing = this.devices.get(device.id);
          if (existing.state !== device.state) {
            existing.state = device.state;
            this.emit('deviceStateChanged', existing);
          }
        }
      }

      for (const id of previousIds) {
        if (!currentIds.has(id)) {
          const device = this.devices.get(id);
          this.devices.delete(id);
          this.stopStreaming(id);
          this.emit('deviceDisconnected', device);
          console.log(`[DeviceManager] Device disconnected: ${id}`);
        }
      }
    } catch (err) {
      console.error('[DeviceManager] Error refreshing devices:', err.message);
    }
  }

  getDevices()       { return Array.from(this.devices.values()); }
  getDevice(id)      { return this.devices.get(id) || null;      }
  isStreaming(id)    { return this.streamingSessions.has(id);    }

  startStreaming(deviceId, options = {}) {
    if (this.streamingSessions.has(deviceId)) {
      return this.streamingSessions.get(deviceId);
    }

    const {
      maxSize = 1080, bitrate = '4M', maxFps = 60,
      noAudio = true, noControl = false,
    } = options;

    const args = [
      '-s', deviceId,
      '--max-size', maxSize.toString(),
      '--bit-rate', bitrate,
      '--max-fps', maxFps.toString(),
      '--window-title', `Android-${deviceId}`,
      '--window-x', '9999', '--window-y', '9999',
      '--window-width', '1', '--window-height', '1',
    ];
    if (noAudio) args.push('--no-audio');
    if (noControl) args.push('--no-control');

    const proc = spawn(this.scrcpyPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    proc.stdout.on('data', (d) => console.log(`[scrcpy:${deviceId}] ${d.toString().trim()}`));
    proc.stderr.on('data', (d) => { const m = d.toString().trim(); if (m) console.log(`[scrcpy:${deviceId}] ${m}`); });
    proc.on('close', (code) => {
      console.log(`[scrcpy:${deviceId}] exited ${code}`);
      this.streamingSessions.delete(deviceId);
      this.emit('streamingStopped', deviceId);
    });
    proc.on('error', (err) => {
      console.error(`[scrcpy:${deviceId}] Error: ${err.message}`);
      this.streamingSessions.delete(deviceId);
      this.emit('streamingError', { deviceId, error: err.message });
    });

    this.streamingSessions.set(deviceId, proc);
    this.emit('streamingStarted', deviceId);
    return proc;
  }

  stopStreaming(deviceId) {
    const proc = this.streamingSessions.get(deviceId);
    if (proc) {
      proc.kill('SIGTERM');
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch (e) {} }, 3000);
      this.streamingSessions.delete(deviceId);
    }
  }

  // ─── Persistent Low-Latency Stream ──────────────────────────────
  // ONE persistent adb process loops screencap on the device continuously.
  // Frames are parsed from the raw PNG stream by detecting PNG boundaries.
  // This eliminates per-frame process-spawn + ADB handshake overhead (~200-500ms saved per frame).
  startRawStream(deviceId, ws, options = {}, wsId) {
    const {
      quality  = 40,   // Lower = smaller payload = less transit time
      maxSize  = 360,  // Smaller frame = faster sharp + faster transfer
      targetFps = 30,
    } = options;

    let running      = true;
    let frameCount   = 0;
    let lastOrient   = -1;
    let proc         = null;
    let buf          = Buffer.alloc(0);
    let processing   = 0;            // concurrent sharp conversions in flight
    const MAX_PROC   = 2;
    const WS_LIMIT   = 80 * 1024;   // 80 KB backpressure limit
    const MIN_FRAME  = Math.floor(1000 / targetFps);
    let lastSent     = 0;

    // PNG frame boundary markers
    const PNG_SIG  = Buffer.from([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A]);
    const PNG_IEND = Buffer.from([0x49,0x45,0x4E,0x44,0xAE,0x42,0x60,0x82]);

    let sharpLib = null;
    try { sharpLib = require('sharp'); } catch (_) {}

    const sendBinary = (buf, fmt) => {
      if (!running || ws.readyState !== 1) return;
      const header = Buffer.alloc(4);
      header.writeUInt8(fmt === 'jpeg' ? 1 : 0, 0);
      header.writeUInt8(0, 1);
      header.writeUInt16BE(frameCount & 0xFFFF, 2);
      try { ws.send(Buffer.concat([header, buf]), { binary: true }); } catch (_) {}
    };

    const processFrame = (pngFrame) => {
      const fc = ++frameCount;
      processing++;

      if (sharpLib) {
        sharpLib(pngFrame)
          .resize(maxSize, null, {
            fit: 'inside',
            withoutEnlargement: true,
            fastShrinkOnLoad: true,
          })
          .jpeg({ quality, mozjpeg: false, progressive: false, chromaSubsampling: '4:2:0' })
          .toBuffer()
          .then(jpegBuf => {
            processing--;
            if (!running || ws.readyState !== 1) return;
            const h = Buffer.alloc(4);
            h.writeUInt8(1, 0); h.writeUInt8(0, 1); h.writeUInt16BE(fc & 0xFFFF, 2);
            try { ws.send(Buffer.concat([h, jpegBuf]), { binary: true }); } catch (_) {}
          })
          .catch(() => { processing--; });
      } else {
        // No sharp: transmit raw PNG (larger but functional)
        processing--;
        sendBinary(pngFrame, 'png');
      }
    };

    const onData = (chunk) => {
      if (!running) return;
      buf = Buffer.concat([buf, chunk]);

      // Extract every complete PNG frame from the buffer
      while (buf.length > 8) {
        const sigPos = buf.indexOf(PNG_SIG);
        if (sigPos === -1) { buf = Buffer.alloc(0); break; }
        if (sigPos > 0) buf = buf.slice(sigPos); // discard garbage before signature

        const iendPos = buf.indexOf(PNG_IEND, 8);
        if (iendPos === -1) break; // frame incomplete — wait for more data

        const frameEnd  = iendPos + PNG_IEND.length;
        const pngFrame  = buf.slice(0, frameEnd);
        buf             = buf.slice(frameEnd);

        // Gating: backpressure + frame-rate cap + concurrent-conversion cap
        const now = Date.now();
        if (ws.bufferedAmount > WS_LIMIT)   continue; // WS backed up — skip
        if (now - lastSent < MIN_FRAME)     continue; // too soon — skip
        if (processing >= MAX_PROC)         continue; // conversions piling up — skip
        lastSent = now;

        processFrame(pngFrame);
      }

      // Safety valve: prevent unbounded buffer growth if IEND never found
      if (buf.length > 4 * 1024 * 1024) {
        console.warn(`[Stream:${deviceId}] buffer overflow — resetting`);
        buf = Buffer.alloc(0);
      }
    };

    const startCapture = () => {
      if (!running) return;
      const dFlag = deviceId ? ['-s', deviceId] : [];
      // Single persistent process — screencap loops on device, no per-frame spawn
      proc = spawn(this.adbPath, [
        ...dFlag, 'exec-out',
        'while true; do screencap -p; done',
      ]);

      proc.stdout.on('data', onData);
      proc.stderr.on('data', () => {});
      proc.on('close', (code) => {
        if (!running) return;
        console.log(`[Stream:${deviceId}] loop exited (${code}), restarting in 600ms…`);
        buf = Buffer.alloc(0);
        setTimeout(startCapture, 600);
      });
      proc.on('error', (err) => {
        if (!running) return;
        console.error(`[Stream:${deviceId}] proc error: ${err.message}`);
        buf = Buffer.alloc(0);
        setTimeout(startCapture, 1000);
      });
    };

    startCapture();

    // Orientation polling — every 5s, lightweight
    const orientTimer = setInterval(async () => {
      if (!running) return;
      try {
        const o = await adb.getOrientation(deviceId);
        if (o !== lastOrient) {
          lastOrient = o;
          if (ws.readyState === 1)
            ws.send(JSON.stringify({ type: 'orientation_changed', rotation: o }));
        }
      } catch (_) {}
    }, 5000);

    if (wsId) this.rawStreams.set(wsId, { deviceId });

    return {
      stop: () => {
        running = false;
        clearInterval(orientTimer);
        if (proc) { try { proc.kill('SIGKILL'); } catch (_) {} proc = null; }
        buf = Buffer.alloc(0);
        if (wsId) this.rawStreams.delete(wsId);
      },
    };
  }

  stopAllStreaming() {
    for (const [deviceId] of this.streamingSessions) this.stopStreaming(deviceId);
  }
}

module.exports = new DeviceManager();
