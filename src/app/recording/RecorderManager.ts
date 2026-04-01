// src/app/recording/RecorderManager.ts
// Complete production-ready RecorderManager with enhanced features

export type RecordedEvent = {
  type: 'tap' | 'swipe' | 'key' | 'text' | 'control';
  timestamp: number;
  payload: any;
  adb?: string;
};

export type RecordingMetadata = {
  recordedAt: number;
  deviceResolution: { width: number; height: number };
  canvasSize: { width: number; height: number };
  scaleFactors: { scaleX: number; scaleY: number };
  eventCount: number;
};

type CoordMapperFn = (elemX: number, elemY: number) => { x: number; y: number };

export class RecorderManager {
  private events: RecordedEvent[] = [];
  private recording = false;
  private element?: HTMLElement;
  private pointerStart?: { x: number; y: number; time: number; id: number };

  // Coordinate mapping
  private customMapper?: CoordMapperFn;
  private deviceSize?: { w: number; h: number };

  // Debug & metadata
  public _debug_deviceSize: { w: number; h: number } | null = null;
  public _debug_elementSize: { w: number; h: number } | null = null;
  public _debug_scaleFactors: { scaleX: number; scaleY: number } | null = null;
  public _debug_isRecording = false;

  // Thresholds
  private readonly TAP_MAX_MOVE_PX = 25;
  private readonly TAP_MAX_DURATION_MS = 450;
  private readonly MIN_SWIPE_DURATION_MS = 120;

  constructor() {
    console.log('[Recorder] Initialized');
  }

  // ==================== PUBLIC API ====================

  /**
   * Set custom coordinate mapper function
   * This takes precedence over internal device size mapping
   */
  public setCoordMapper(fn: CoordMapperFn) {
    if (typeof fn !== 'function') {
      console.warn('[Recorder] setCoordMapper: fn is not a function');
      return;
    }

    this.customMapper = (x, y) => {
      try {
        const p = fn(x, y);
        if (!p || typeof p.x !== 'number' || typeof p.y !== 'number') {
          console.warn('[Recorder] setCoordMapper: invalid return from mapper', p);
          return { x: Math.round(x), y: Math.round(y) };
        }
        return { x: Math.round(p.x), y: Math.round(p.y) };
      } catch (e) {
        console.error('[Recorder] setCoordMapper: mapper function threw error', e);
        return { x: Math.round(x), y: Math.round(y) };
      }
    };

    console.info('[Recorder] Custom mapper installed');
  }

  /**
   * Set device resolution (from adb shell wm size)
   * This enables automatic scaling calculation
   */
  public setDeviceSize(width: number, height: number) {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      console.error('[Recorder] setDeviceSize: invalid dimensions', { width, height });
      return;
    }

    this.deviceSize = { w: Math.round(width), h: Math.round(height) };
    this._debug_deviceSize = { w: this.deviceSize.w, h: this.deviceSize.h };
    console.info('[Recorder] Device size set', this.deviceSize);

    // Recalculate scale if element is attached
    if (this.element) {
      this.updateScaleFactors();
    }
  }

  /**
   * Attach recorder to canvas/display element
   * Captures pointer events from this element
   */
  public attachToElement(elem: HTMLElement) {
    if (!elem) {
      console.warn('[Recorder] attachToElement: element is null/undefined');
      return;
    }

    // Detach previous if any
    this.detach();

    this.element = elem;
    elem.addEventListener('pointerdown', this.onPointerDown, { passive: true });
    elem.addEventListener('pointerup', this.onPointerUp, { passive: true });

    // Update debug info
    const rect = elem.getBoundingClientRect();
    this._debug_elementSize = { w: Math.round(rect.width), h: Math.round(rect.height) };

    console.info('[Recorder] Attached to element', this._debug_elementSize);

    // Recalculate scale factors
    this.updateScaleFactors();
  }

  /**
   * Detach from element
   */
  public detach() {
    if (!this.element) return;

    this.element.removeEventListener('pointerdown', this.onPointerDown);
    this.element.removeEventListener('pointerup', this.onPointerUp);
    this.element = undefined;
    this.pointerStart = undefined;

    console.info('[Recorder] Detached from element');
  }

  /**
   * Start recording events
   */
  public start() {
    if (this.recording) {
      console.warn('[Recorder] Already recording');
      return;
    }

    if (!this.element) {
      console.error('[Recorder] Cannot start: no element attached');
      return;
    }

    this.events = [];
    this.recording = true;
    this._debug_isRecording = true;

    console.info('[Recorder] Recording started');
  }

  /**
   * Stop recording events
   */
  public stop() {
    if (!this.recording) {
      console.warn('[Recorder] Not currently recording');
      return;
    }

    this.recording = false;
    this.pointerStart = undefined;
    this._debug_isRecording = false;

    console.info('[Recorder] Recording stopped (events=%d)', this.events.length);
  }

  /**
   * Check if currently recording
   */
  public isRecording(): boolean {
    return this.recording;
  }

  /**
   * Get recorded events
   */
  public getData(): RecordedEvent[] {
    return this.events.slice();
  }

  /**
   * Get metadata about this recording
   */
  public getMetadata(): RecordingMetadata | null {
    if (!this._debug_deviceSize || !this._debug_elementSize) {
      console.warn('[Recorder] getMetadata: missing device or element size');
      return null;
    }

    return {
      recordedAt: Date.now(),
      deviceResolution: {
        width: this._debug_deviceSize.w,
        height: this._debug_deviceSize.h,
      },
      canvasSize: {
        width: this._debug_elementSize.w,
        height: this._debug_elementSize.h,
      },
      scaleFactors: this._debug_scaleFactors || { scaleX: 1, scaleY: 1 },
      eventCount: this.events.length,
    };
  }

  /**
   * Export as JSON string with metadata
   */
  public toJson(): string {
    const data = {
      metadata: this.getMetadata(),
      events: this.getData(),
    };
    return JSON.stringify(data, null, 2);
  }

  /**
   * Called by StreamClientScrcpy to capture outgoing control messages
   * Filters noisy pointer samples
   */
  public pushControlMessage(msg: any) {
    if (!this.recording) return;

    try {
      // Skip noisy raw pointer samples (type 2 = mouse/touch position)
      if (msg && msg.type === 2 && msg.position && msg.position.point) {
        return;
      }

      // Detect and handle specific message types
      if (msg && typeof msg === 'object') {
        if (typeof msg.text === 'string') {
          this.addText(msg.text);
          return;
        }

        const keyCode = (msg as any).keycode ?? (msg as any).keyCode;
        if (typeof keyCode === 'number') {
          this.addKey(keyCode);
          return;
        }
      }

      // Fallback for unknown control messages
      this.addControl(msg);
    } catch (e) {
      console.warn('[Recorder] pushControlMessage error', e);
    }
  }

  /**
   * Save recording to server
   */
  public async saveToServer(name?: string): Promise<{ ok: boolean; path?: string; error?: string }> {
    try {
      if (!name) {
        name = `rec_${Date.now()}.json`;
      }

      if (!name.endsWith('.json')) {
        name += '.json';
      }

      // Create payload with metadata
      const payload = {
        name,
        metadata: this.getMetadata(),
        data: this.getData(),
      };

      const resp = await fetch(`${location.origin}/api/recordings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!resp.ok) {
        return { ok: false, error: `HTTP ${resp.status}` };
      }

      const j = await resp.json();
      console.info('[Recorder] Saved to server', j);
      return j;
    } catch (err: any) {
      console.error('[Recorder] saveToServer failed', err);
      return { ok: false, error: err?.message || String(err) };
    }
  }

  /**
   * Request replay of a recording from server
   * Backward compatible with old JSON format
   */
  public async requestReplay(name: string, delayMs?: number): Promise<{ ok: boolean; error?: string }> {
    try {
      if (!name) {
        return { ok: false, error: 'Recording name required' };
      }

      const resp = await fetch(`${location.origin}/api/recordings/play`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, delayMs: delayMs || 120 }),
      });

      if (!resp.ok) {
        return { ok: false, error: `HTTP ${resp.status}` };
      }

      const j = await resp.json();
      console.info('[Recorder] Replay requested', j);
      return j;
    } catch (err: any) {
      console.error('[Recorder] requestReplay failed', err);
      return { ok: false, error: err?.message || String(err) };
    }
  }

  /**
   * Get list of available recordings from server
   */
  public async listRecordings(): Promise<{ ok: boolean; recordings?: string[]; error?: string }> {
    try {
      const resp = await fetch(`${location.origin}/api/recordings`, {
        method: 'GET',
      });

      if (!resp.ok) {
        return { ok: false, error: `HTTP ${resp.status}` };
      }

      return await resp.json();
    } catch (err: any) {
      console.error('[Recorder] listRecordings failed', err);
      return { ok: false, error: err?.message || String(err) };
    }
  }

  // ==================== PRIVATE HELPERS ====================

  /**
   * Update scale factors based on current device and element sizes
   */
  private updateScaleFactors() {
    if (!this.deviceSize || !this.element) {
      console.warn('[Recorder] updateScaleFactors: missing device size or element');
      return;
    }

    try {
      const rect = this.element.getBoundingClientRect();
      const canvasW = rect.width || this.element.clientWidth || 1;
      const canvasH = rect.height || this.element.clientHeight || 1;

      const scaleX = this.deviceSize.w / canvasW;
      const scaleY = this.deviceSize.h / canvasH;

      this._debug_scaleFactors = { scaleX, scaleY };

      console.log('[Recorder] Scale factors updated', {
        deviceSize: this.deviceSize,
        canvasSize: { w: canvasW, h: canvasH },
        scales: { scaleX: scaleX.toFixed(2), scaleY: scaleY.toFixed(2) },
      });
    } catch (e) {
      console.error('[Recorder] updateScaleFactors error', e);
    }
  }

  // ==================== POINTER HANDLERS ====================

  private onPointerDown = (ev: PointerEvent) => {
    if (!this.recording || !this.element) return;

    try {
      const rect = this.element.getBoundingClientRect();
      const x = ev.clientX - rect.left;
      const y = ev.clientY - rect.top;

      this.pointerStart = {
        x: Math.max(0, x),
        y: Math.max(0, y),
        time: Date.now(),
        id: ev.pointerId,
      };
    } catch (e) {
      console.warn('[Recorder] onPointerDown error', e);
    }
  };

  private onPointerUp = (ev: PointerEvent) => {
    if (!this.recording || !this.element) return;
    if (!this.pointerStart) return;

    try {
      const rect = this.element.getBoundingClientRect();
      const x = ev.clientX - rect.left;
      const y = ev.clientY - rect.top;

      // Update debug element size
      this._debug_elementSize = { w: Math.round(rect.width), h: Math.round(rect.height) };

      const start = this.pointerStart;
      this.pointerStart = undefined;

      const dx = x - start.x;
      const dy = y - start.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const dt = Date.now() - start.time;

      // Distinguish tap vs swipe
      if (dist <= this.TAP_MAX_MOVE_PX && dt <= this.TAP_MAX_DURATION_MS) {
        this.addTap(x, y);
      } else {
        const duration = Math.max(this.MIN_SWIPE_DURATION_MS, Math.round(dt));
        this.addSwipe(start.x, start.y, x, y, duration);
      }
    } catch (e) {
      console.warn('[Recorder] onPointerUp error', e);
    }
  };

  // ==================== EVENT CREATORS ====================

  private addTap(elemX: number, elemY: number) {
    if (!this.recording) return;

    const mapped = this.mapToDevice(elemX, elemY);
    if (!mapped) {
      console.warn('[Recorder] addTap: mapping failed');
      return;
    }

    const xi = Math.round(mapped.x);
    const yi = Math.round(mapped.y);

    const ev: RecordedEvent = {
      type: 'tap',
      timestamp: Date.now(),
      payload: { x: xi, y: yi },
      adb: `adb shell input tap ${xi} ${yi}`,
    };

    this.events.push(ev);
    console.debug('[Recorder] Tap recorded', { x: xi, y: yi });
  }

  private addSwipe(
    elemX1: number,
    elemY1: number,
    elemX2: number,
    elemY2: number,
    durationMs: number
  ) {
    if (!this.recording) return;

    const p1 = this.mapToDevice(elemX1, elemY1);
    const p2 = this.mapToDevice(elemX2, elemY2);

    if (!p1 || !p2) {
      console.warn('[Recorder] addSwipe: mapping failed');
      return;
    }

    const x1 = Math.round(p1.x);
    const y1 = Math.round(p1.y);
    const x2 = Math.round(p2.x);
    const y2 = Math.round(p2.y);
    const dur = Math.round(durationMs);

    const ev: RecordedEvent = {
      type: 'swipe',
      timestamp: Date.now(),
      payload: { x1, y1, x2, y2, duration: dur },
      adb: `adb shell input swipe ${x1} ${y1} ${x2} ${y2} ${dur}`,
    };

    this.events.push(ev);
    console.debug('[Recorder] Swipe recorded', { x1, y1, x2, y2, duration: dur });
  }

  public addKey(keycode: number) {
    if (!this.recording) return;

    if (!Number.isFinite(keycode)) {
      console.warn('[Recorder] addKey: invalid keycode', keycode);
      return;
    }

    const kc = Math.round(keycode);

    const ev: RecordedEvent = {
      type: 'key',
      timestamp: Date.now(),
      payload: { keycode: kc },
      adb: `adb shell input keyevent ${kc}`,
    };

    this.events.push(ev);
    console.debug('[Recorder] Key recorded', kc);
  }

  public addText(text: string) {
    if (!this.recording) return;

    if (typeof text !== 'string') {
      console.warn('[Recorder] addText: text is not a string', typeof text);
      return;
    }

    const safe = text.replace(/"/g, '\\"').replace(/'/g, "\\'");

    const ev: RecordedEvent = {
      type: 'text',
      timestamp: Date.now(),
      payload: { text },
      adb: `adb shell input text "${safe}"`,
    };

    this.events.push(ev);
    console.debug('[Recorder] Text recorded', text);
  }

  public addControl(cmd: any) {
    if (!this.recording) return;

    const ev: RecordedEvent = {
      type: 'control',
      timestamp: Date.now(),
      payload: cmd,
      adb: undefined,
    };

    this.events.push(ev);
    console.debug('[Recorder] Control recorded', cmd);
  }

  // ==================== MAPPING LOGIC ====================

  /**
   * Map canvas coordinates to device coordinates
   * Uses custom mapper first, then device size-based scaling
   */
  private mapToDevice(elemX: number, elemY: number): { x: number; y: number } | null {
    // 1) Try custom mapper if present
    if (this.customMapper) {
      try {
        const result = this.customMapper(elemX, elemY);
        if (result && typeof result.x === 'number' && typeof result.y === 'number') {
          return result;
        }
        console.warn('[Recorder] Custom mapper returned invalid result', result);
      } catch (e) {
        console.error('[Recorder] Custom mapper threw error', e);
      }
    }

    // 2) Use device size-based direct scaling (NEW CLEANER LOGIC)
    if (this.deviceSize && this.element) {
      try {
        const rect = this.element.getBoundingClientRect();
        const canvasW = rect.width || this.element.clientWidth || 1;
        const canvasH = rect.height || this.element.clientHeight || 1;

        const scaleX = this.deviceSize.w / canvasW;
        const scaleY = this.deviceSize.h / canvasH;

        const devX = elemX * scaleX;
        const devY = elemY * scaleY;

        return {
          x: Math.round(Math.max(0, Math.min(devX, this.deviceSize.w - 1))),
          y: Math.round(Math.max(0, Math.min(devY, this.deviceSize.h - 1))),
        };
      } catch (e) {
        console.error('[Recorder] Device size-based mapping failed', e);
      }
    }

    // 3) Fallback: pass-through (lossy, but better than null)
    console.warn('[Recorder] mapToDevice: no mapping available, using fallback');
    return {
      x: Math.round(Math.max(0, elemX)),
      y: Math.round(Math.max(0, elemY)),
    };
  }
}

// ==================== SINGLETON & EXPORTS ====================

export const recorder = new RecorderManager();
export default recorder;
