// src/app/googDevice/client/StreamClientScrcpy.ts
// COMPLETE ERROR-FREE FILE

import { BaseClient } from '../../client/BaseClient';
import { ParamsStreamScrcpy } from '../../../types/ParamsStreamScrcpy';
import { GoogMoreBox } from '../toolbox/GoogMoreBox';
import { GoogToolBox } from '../toolbox/GoogToolBox';
import VideoSettings from '../../VideoSettings';
import Size from '../../Size';
import { ControlMessage } from '../../controlMessage/ControlMessage';
import { ClientsStats, DisplayCombinedInfo } from '../../client/StreamReceiver';
import { CommandControlMessage } from '../../controlMessage/CommandControlMessage';
import Util from '../../Util';
import FilePushHandler from '../filePush/FilePushHandler';
import DragAndPushLogger from '../DragAndPushLogger';
import { KeyEventListener, KeyInputHandler } from '../KeyInputHandler';
import { KeyCodeControlMessage } from '../../controlMessage/KeyCodeControlMessage';
import { BasePlayer, PlayerClass } from '../../player/BasePlayer';
import GoogDeviceDescriptor from '../../../types/GoogDeviceDescriptor';
import { ConfigureScrcpy } from './ConfigureScrcpy';
import { DeviceTracker } from './DeviceTracker';
import { html } from '../../ui/HtmlTag';
import {
  FeaturedInteractionHandler,
  InteractionHandlerListener,
} from '../../interactionHandler/FeaturedInteractionHandler';
import DeviceMessage from '../DeviceMessage';
import { DisplayInfo } from '../../DisplayInfo';
import { Attribute } from '../../Attribute';
import { HostTracker } from '../../client/HostTracker';
import { ACTION } from '../../../common/Action';
import { StreamReceiverScrcpy } from './StreamReceiverScrcpy';
import { ParamsDeviceTracker } from '../../../types/ParamsDeviceTracker';
import { ScrcpyFilePushStream } from '../filePush/ScrcpyFilePushStream';

// RECORDER IMPORT
import recorder from '../../recording/RecorderManager';

type StartParams = {
  udid: string;
  playerName?: string;
  player?: BasePlayer;
  fitToScreen?: boolean;
  videoSettings?: VideoSettings;
};

const TAG = '[StreamClientScrcpy]';

export class StreamClientScrcpy
  extends BaseClient<ParamsStreamScrcpy, Record<string, any>>
  implements KeyEventListener, InteractionHandlerListener
{
  public static ACTION = 'stream';
  private static players: Map<string, PlayerClass> = new Map();
  private controlButtons?: HTMLElement;
  private deviceName = '';
  private clientId = -1;
  private clientsCount = -1;
  private joinedStream = false;
  private requestedVideoSettings?: VideoSettings;
  private touchHandler?: FeaturedInteractionHandler;
  private moreBox?: GoogMoreBox;
  private player?: BasePlayer;
  private filePushHandler?: FilePushHandler;
  private fitToScreen?: boolean;
  private readonly streamReceiver: StreamReceiverScrcpy;
  // Resize observer used to re-install mapper
  private resizeObserver: ResizeObserver | null = null;
  private deviceResolution?: { width: number; height: number};

  public static registerPlayer(playerClass: PlayerClass): void {
    if (playerClass.isSupported()) {
      this.players.set(playerClass.playerFullName, playerClass);
    }
  }

  public static getPlayers(): PlayerClass[] {
    return Array.from(this.players.values());
  }

  private static getPlayerClass(playerName: string): PlayerClass | undefined {
    let playerClass: PlayerClass | undefined;
    for (const value of StreamClientScrcpy.players.values()) {
      if (value.playerFullName === playerName || value.playerCodeName === playerName) {
        playerClass = value;
      }
    }
    return playerClass;
  }

  public static createPlayer(playerName: string, udid: string, displayInfo?: DisplayInfo): BasePlayer | undefined {
    const playerClass = this.getPlayerClass(playerName);
    if (!playerClass) {
      return;
    }
    return new playerClass(udid, displayInfo);
  }

  public static getFitToScreen(playerName: string, udid: string, displayInfo?: DisplayInfo): boolean {
    const playerClass = this.getPlayerClass(playerName);
    if (!playerClass) {
      return false;
    }
    return playerClass.getFitToScreenStatus(udid, displayInfo);
  }

  public static start(
    query: URLSearchParams | ParamsStreamScrcpy,
    streamReceiver?: StreamReceiverScrcpy,
    player?: BasePlayer,
    fitToScreen?: boolean,
    videoSettings?: VideoSettings,
  ): StreamClientScrcpy {
    if (query instanceof URLSearchParams) {
      const params = StreamClientScrcpy.parseParameters(query);
      return new StreamClientScrcpy(params, streamReceiver, player, fitToScreen, videoSettings);
    } else {
      return new StreamClientScrcpy(query, streamReceiver, player, fitToScreen, videoSettings);
    }
  }

  private static createVideoSettingsWithBounds(old: VideoSettings, newBounds: Size): VideoSettings {
    return new VideoSettings({
      crop: old.crop,
      bitrate: old.bitrate,
      bounds: newBounds,
      maxFps: old.maxFps,
      iFrameInterval: old.iFrameInterval,
      sendFrameMeta: old.sendFrameMeta,
      lockedVideoOrientation: old.lockedVideoOrientation,
      displayId: old.displayId,
      codecOptions: old.codecOptions,
      encoderName: old.encoderName,
    });
  }

    /** Insert top-left logo into body.stream (only once) */
  private insertLogo(): void {
    // avoid duplicating logo if multiple StreamClientScrcpy instances are created
    if (document.querySelector('.stream-logo')) {
      return;
    }
 
    const img = document.createElement('img');
    img.className = 'stream-logo';
    img.src = '/rutomatrix.png';
    img.alt = 'RutoMatrix logo';
 
    // you can keep styling in CSS (preferred) or inline:
    img.style.position = 'fixed';
    img.style.top = '16px';
    img.style.left = '16px';
    img.style.height = '40px';
    img.style.zIndex = '1000';
    img.style.pointerEvents = 'none';
 
    document.body.appendChild(img);
  }

  protected constructor(
    params: ParamsStreamScrcpy,
    streamReceiver?: StreamReceiverScrcpy,
    player?: BasePlayer,
    fitToScreen?: boolean,
    videoSettings?: VideoSettings,
  ) {
    super(params);
    if (streamReceiver) {
      this.streamReceiver = streamReceiver;
    } else {
      this.streamReceiver = new StreamReceiverScrcpy(this.params);
    }

    const { udid, player: playerName } = this.params;
    this.startStream({ udid, player, playerName, fitToScreen, videoSettings });
    this.setBodyClass('stream');
    this.insertLogo();
  }

  public static parseParameters(params: URLSearchParams): ParamsStreamScrcpy {
    const typedParams = super.parseParameters(params);
    const { action } = typedParams;
    if (action !== ACTION.STREAM_SCRCPY) {
      throw Error('Incorrect action');
    }

    return {
      ...typedParams,
      action,
      player: Util.parseString(params, 'player', true),
      udid: Util.parseString(params, 'udid', true),
      ws: Util.parseString(params, 'ws', true),
    };
  }

  public OnDeviceMessage = (message: DeviceMessage): void => {
    if (this.moreBox) {
      this.moreBox.OnDeviceMessage(message);
    }
  };

  public onVideo = (data: ArrayBuffer): void => {
    if (!this.player) {
      return;
    }

    const STATE = BasePlayer.STATE;
    if (this.player.getState() === STATE.PAUSED) {
      this.player.play();
    }

    if (this.player.getState() === STATE.PLAYING) {
      this.player.pushFrame(new Uint8Array(data));
    }
  };

  public onClientsStats = (stats: ClientsStats): void => {
    this.deviceName = stats.deviceName;
    this.clientId = stats.clientId;
    this.setTitle(`Stream ${this.deviceName}`);
  };

  public onDisplayInfo = (infoArray: DisplayCombinedInfo[]): void => {
    if (!this.player) {
      return;
    }

    let currentSettings = this.player.getVideoSettings();
    const displayId = currentSettings.displayId;
    const info = infoArray.find((value) => {
      return value.displayInfo.displayId === displayId;
    });

    if (!info) {
      return;
    }

    if (this.player.getState() === BasePlayer.STATE.PAUSED) {
      this.player.play();
    }

    const { videoSettings, screenInfo } = info;
    this.player.setDisplayInfo(info.displayInfo);

    // --- Recorder mapping update: keep recorder synced with latest screenInfo ---
    try {
      const screenInfoData = (info as any).screenInfo || this.player?.getScreenInfo?.();
      if (screenInfoData && recorder) {
        // If scrcpy reports the videoSize (may be scaled), use it
        if (screenInfoData.videoSize && screenInfoData.videoSize.width && screenInfoData.videoSize.height) {
          recorder.setDeviceSize(screenInfoData.videoSize.width, screenInfoData.videoSize.height);
        }

        // If scrcpy reports crop region, pass it to recorder
        const crop = (screenInfoData as any).crop;
        if (crop && typeof crop.x === 'number') {
          (recorder as any).setDeviceCrop(crop.x || 0, crop.y || 0, crop.w || crop.width || 0, crop.h || crop.height || 0);
        }

        // Ensure recorder is attached to the same element used for touch events
        const elem = this.player?.getTouchableElement && this.player.getTouchableElement();
        if (elem) {
          recorder.attachToElement(elem);
        }
      }
    } catch (e) {
      console.warn('[Recorder] onDisplayInfo mapping update failed', e);
    }

    // Re-install mapper when new screenInfo arrives (important!)
    try {
      const elem = this.player.getTouchableElement && this.player.getTouchableElement();
      if (elem) {
        this.installCoordMapper(elem);
      }
    } catch (e) {
      console.warn('[Recorder] installCoordMapper in onDisplayInfo failed', e);
    }

    if (typeof this.fitToScreen !== 'boolean') {
      this.fitToScreen = this.player.getFitToScreenStatus();
    }

    if (this.fitToScreen) {
      const newBounds = this.getMaxSize();
      if (newBounds) {
        currentSettings = StreamClientScrcpy.createVideoSettingsWithBounds(currentSettings, newBounds);
        this.player.setVideoSettings(currentSettings, this.fitToScreen, false);
      }
    }

    if (!videoSettings || !screenInfo) {
      this.joinedStream = true;
      this.sendMessage(CommandControlMessage.createSetVideoSettingsCommand(currentSettings));
      return;
    }

    this.clientsCount = info.connectionCount;
    let min = VideoSettings.copy(videoSettings);
    const oldInfo = this.player.getScreenInfo();
    if (!screenInfo.equals(oldInfo)) {
      this.player.setScreenInfo(screenInfo);
    }

    if (!videoSettings.equals(currentSettings)) {
      this.applyNewVideoSettings(videoSettings, videoSettings.equals(this.requestedVideoSettings));
    }

    if (!oldInfo) {
      const bounds = currentSettings.bounds;
      const videoSize: Size = screenInfo.videoSize;
      const onlyOneClient = this.clientsCount === 0;
      const smallerThenCurrent = bounds && (bounds.width < videoSize.width || bounds.height < videoSize.height);

      if (onlyOneClient || smallerThenCurrent) {
        min = currentSettings;
      }
    }

    const minBounds = currentSettings.bounds?.intersect(min.bounds);
    if (minBounds && !minBounds.equals(min.bounds)) {
      min = StreamClientScrcpy.createVideoSettingsWithBounds(min, minBounds);
    }

    if (!min.equals(videoSettings) || !this.joinedStream) {
      this.joinedStream = true;
      this.sendMessage(CommandControlMessage.createSetVideoSettingsCommand(min));
    }
  };

  public onDisconnected = (): void => {
    this.streamReceiver.off('deviceMessage', this.OnDeviceMessage);
    this.streamReceiver.off('video', this.onVideo);
    this.streamReceiver.off('clientsStats', this.onClientsStats);
    this.streamReceiver.off('displayInfo', this.onDisplayInfo);
    this.streamReceiver.off('disconnected', this.onDisconnected);

    // cleanup recorder observer if present
    try {
      if (this.resizeObserver) {
        try {
          this.resizeObserver.disconnect();
        } catch (_) {}
        this.resizeObserver = null;
      }
    } catch (e) {
      // ignore
    }

    this.filePushHandler?.release();
    this.filePushHandler = undefined;
    this.touchHandler?.release();
    this.touchHandler = undefined;
  };

  public startStream({ udid, player, playerName, videoSettings, fitToScreen }: StartParams): void {
    if (!udid) {
      throw Error(`Invalid udid value: "${udid}"`);
    }
    this.fetchDeviceResolution(this.params.udid || udid);
    this.fitToScreen = fitToScreen;
    if (!player) {
      if (typeof playerName !== 'string') {
        throw Error('Must provide BasePlayer instance or playerName');
      }
  
      let displayInfo: DisplayInfo | undefined;
      if (this.streamReceiver && videoSettings) {
        displayInfo = this.streamReceiver.getDisplayInfo(videoSettings.displayId);
      }
  
      const p = StreamClientScrcpy.createPlayer(playerName, udid, displayInfo);
      if (!p) {
        throw Error(`Unsupported player: "${playerName}"`);
      }
  
      if (typeof fitToScreen !== 'boolean') {
        fitToScreen = StreamClientScrcpy.getFitToScreen(playerName, udid, displayInfo);
      }
  
      player = p;
    }
  
    this.player = player;
    this.setTouchListeners(player);
    if (!videoSettings) {
      videoSettings = player.getVideoSettings();
    }
  
    const deviceView = document.createElement('div');
    deviceView.className = 'device-view';
    const stop = (ev?: string | Event) => {
      if (ev && ev instanceof Event && ev.type === 'error') {
        console.error(TAG, ev);
      }
  
      let parent;
      parent = deviceView.parentElement;
      if (parent) {
        parent.removeChild(deviceView);
      }
  
      parent = moreBox.parentElement;
      if (parent) {
        parent.removeChild(moreBox);
      }
  
      this.streamReceiver.stop();
      if (this.player) {
        this.player.stop();
      }
    };
  
    const googMoreBox = (this.moreBox = new GoogMoreBox(udid, player, this));
    const moreBox = googMoreBox.getHolderElement();
    googMoreBox.setOnStop(stop);
    const googToolBox = GoogToolBox.createToolBox(udid, player, this, moreBox);
    this.controlButtons = googToolBox.getHolderElement();
    deviceView.appendChild(this.controlButtons);
  
    const video = document.createElement('div');
    video.className = 'video';
    deviceView.appendChild(video);
    deviceView.appendChild(moreBox);
    player.setParent(video);
    player.pause();
    document.body.appendChild(deviceView);
  
    if (fitToScreen) {
      const newBounds = this.getMaxSize();
      if (newBounds) {
        videoSettings = StreamClientScrcpy.createVideoSettingsWithBounds(videoSettings, newBounds);
      }
    }
  
    this.applyNewVideoSettings(videoSettings, false);
    const element = player.getTouchableElement();
    const logger = new DragAndPushLogger(element);
    this.filePushHandler = new FilePushHandler(element, new ScrcpyFilePushStream(this.streamReceiver));
    this.filePushHandler.addEventListener(logger);
  
    // install a robust coordinate mapper & attach recorder to same element
    try {
      if (element && recorder) {
        // ensure recorder attached to the element
        try {
          recorder.attachToElement(element);
        } catch (e) {
          console.warn('[Recorder] attachToElement failed', e);
        }
  
        // install/refresh mapper (function defined below)
        this.installCoordMapper(element);
      }
    } catch (e) {
      console.warn('[Recorder] coordinate mapper attach failed', e);
    }
  
       // ---- Recorder control buttons (SVG icons inside control-buttons-list) ----
    try {
      // currently selected recording for Play
      let currentRecordingName: string | null = null;
 
      const recIconSvg = `
<svg viewBox="0 0 24 24" class="icon icon-rec" aria-hidden="true">
<circle cx="12" cy="12" r="8"></circle>
</svg>
      `;
      const pauseIconSvg = `
<svg viewBox="0 0 24 24" class="icon icon-pause" aria-hidden="true">
<rect x="7" y="6" width="4" height="12"></rect>
<rect x="13" y="6" width="4" height="12"></rect>
</svg>
      `;
      const playIconSvg = `
<svg viewBox="0 0 24 24" class="icon icon-play" aria-hidden="true">
<polygon points="9,7 17,12 9,17"></polygon>
</svg>
      `;
      const listIconSvg = `
<svg viewBox="0 0 24 24" class="icon icon-list" aria-hidden="true">
<rect x="5" y="7" width="14" height="2"></rect>
<rect x="5" y="11" width="14" height="2"></rect>
<rect x="5" y="15" width="14" height="2"></rect>
</svg>
      `;
 
      const recBtn = document.createElement('button');
      recBtn.type = 'button';
      recBtn.className = 'control-button recorder-record';
      recBtn.innerHTML = recIconSvg;
      recBtn.title = 'Start recording';
 
      const playBtn = document.createElement('button');
      playBtn.type = 'button';
      playBtn.className = 'control-button recorder-play';
      playBtn.innerHTML = playIconSvg;
      playBtn.title = 'Play recording (no file selected)';
      // (2) initially disabled
      playBtn.disabled = true;
      playBtn.classList.add('is-disabled');
 
      const listBtn = document.createElement('button');
      listBtn.type = 'button';
      listBtn.className = 'control-button recorder-list';
      listBtn.innerHTML = listIconSvg;
      listBtn.title = 'Show recordings';
 
      // helper: enable/disable + glow Play based on currentRecordingName
      const updatePlayButtonState = () => {
        if (currentRecordingName) {
          playBtn.disabled = false;
          playBtn.classList.remove('is-disabled');
          playBtn.classList.add('has-recording');       // glow class
          playBtn.title = `Play ${currentRecordingName}`;
        } else {
          playBtn.disabled = true;
          playBtn.classList.add('is-disabled');
          playBtn.classList.remove('has-recording');
          playBtn.title = 'Play recording (no file selected)';
        }
      };
 
      updatePlayButtonState();
 
      // (2) Record button: start/stop, and after save -> set currentRecordingName & enable Play
      recBtn.onclick = async () => {
        try {
          if (!recorder.isRecording()) {
            // starting a new recording clears old selection
            currentRecordingName = null;
            updatePlayButtonState();
 
            recorder.start();
            recBtn.classList.add('is-recording');
            recBtn.innerHTML = pauseIconSvg;
            recBtn.title = 'Stop recording';
          } else {
            recorder.stop();
            recBtn.classList.remove('is-recording');
            recBtn.innerHTML = recIconSvg;
            recBtn.title = 'Start recording';
 
            const saveRes = await recorder.saveToServer();
            if (!saveRes.ok) {
              console.warn('Failed to save recording', saveRes.error);
              alert('Save failed: ' + (saveRes.error || 'unknown'));
            } else {
              const path = saveRes.path || '';
              const fileName = path.split(/[\\/]/).pop() || '';
              currentRecordingName = fileName || null;
              updatePlayButtonState();   // now Play becomes clickable + glows
              alert('Saved: ' + (fileName || path));
            }
          }
        } catch (e) {
          console.error('recBtn click error', e);
        }
      };
 
      // (2) Play button: only works when a recording is selected
      playBtn.onclick = async () => {
        try {
          if (!currentRecordingName) {
            alert('No recording selected yet');
            return;
          }
          const res = await recorder.requestReplay(currentRecordingName);
          if (!res.ok) {
            alert('Play failed: ' + (res.error || 'unknown'));
          } else {
            alert('Play triggered for ' + currentRecordingName);
          }
        } catch (e) {
          console.error('playBtn click error', e);
        }
      };
 
      // (3) List button: show all saved recordings, choose one, then enable Play
      listBtn.onclick = async () => {
        try {
          const res = await recorder.listRecordings();
          if (!res.ok || !res.recordings || !res.recordings.length) {
            alert('No recordings found');
            return;
          }
 
          const listText = res.recordings
            .map((name, idx) => `${idx + 1}. ${name}`)
            .join('\n');
 
          const choice = prompt(
            'Select recording by number:\n\n' + listText + '\n\nEnter number:'
          );
          if (!choice) return;
 
          const idx = parseInt(choice, 10);
          if (!Number.isFinite(idx) || idx < 1 || idx > res.recordings.length) {
            alert('Invalid selection');
            return;
          }
 
          currentRecordingName = res.recordings[idx - 1];
          updatePlayButtonState();      // Play now clickable + glow
        } catch (e) {
          console.error('listBtn click error', e);
        }
      };
 
      // for debugging
      (window as any).recorder = recorder;
 
      if (this.controlButtons) {
        this.controlButtons.appendChild(recBtn);
        this.controlButtons.appendChild(playBtn);
        this.controlButtons.appendChild(listBtn);
      }
    } catch (e) {
      console.warn('[Recorder] attach failed', e);
    }
  
    const streamReceiver = this.streamReceiver;
    streamReceiver.on('deviceMessage', this.OnDeviceMessage);
    streamReceiver.on('video', this.onVideo);
    streamReceiver.on('clientsStats', this.onClientsStats);
    streamReceiver.on('displayInfo', this.onDisplayInfo);
    streamReceiver.on('disconnected', this.onDisconnected);
    console.log(TAG, player.getName(), udid);
  }

    // Fetch physical device resolution via backend (/api/device-resolution → adb wm size)

    private async fetchDeviceResolution(udid: string): Promise<void> {

      try {

        const res = await fetch('/api/device-resolution', {

          method: 'POST',

          headers: { 'Content-Type': 'application/json' },

          body: JSON.stringify({ udid }),

        });
  
        const json = await res.json();

        if (!json || !json.ok || !json.width || !json.height) {

          console.warn('[StreamClientScrcpy] /api/device-resolution error', json);

          return;

        }
  
        this.deviceResolution = { width: json.width, height: json.height };

        console.log('[StreamClientScrcpy] adb device resolution', this.deviceResolution);
  
        // Sync recorder with physical resolution

        try {

          if (recorder && typeof recorder.setDeviceSize === 'function') {

            recorder.setDeviceSize(json.width, json.height);

          }

        } catch (e) {

          console.warn('[Recorder] setDeviceSize from adb failed', e);

        }
  
        // Re-install coord mapper now that we know the exact resolution

        try {

          const elem = this.player?.getTouchableElement && this.player.getTouchableElement();

          if (elem) {

            this.installCoordMapper(elem);

          }

        } catch (e) {

          console.warn('[Recorder] re-install mapper after adb size failed', e);

        }

      } catch (e) {

        console.warn('[StreamClientScrcpy] fetchDeviceResolution failed', e);

      }

    }

  

  // Helper: install coordinate mapper for an element (robust, re-usable)
  private installCoordMapper(element: HTMLElement) {
    if (!element || !recorder) return;
    const install = () => {
      try {
        const screenInfo = this.player?.getScreenInfo();
        const fallbackVideoSize = screenInfo?.videoSize;
 
        // Prefer physical resolution from adb; fall back to scrcpy videoSize
        const deviceW =
          this.deviceResolution?.width || (fallbackVideoSize && fallbackVideoSize.width);
        const deviceH =
          this.deviceResolution?.height || (fallbackVideoSize && fallbackVideoSize.height);
 
        if (!deviceW || !deviceH) {
          console.warn('[Recorder] installCoordMapper: no device resolution yet');
          return;
        }
 
        const mapper = (elemX: number, elemY: number) => {
          // read rect fresh each time to handle reflow/scalelo..


          
          const r = element.getBoundingClientRect();
          const w = r.width || element.clientWidth || 1;
          const h = r.height || element.clientHeight || 1;
 
          // --- aspect-ratio–aware mapping (removes black bars) ---
          const deviceRatio = deviceW / deviceH;
          const elemRatio = w / h;
 
          let videoX = 0;
          let videoY = 0;
          let videoW = w;
          let videoH = h;
 
          if (elemRatio > deviceRatio) {
            // element wider → side bars
            videoH = h;
            videoW = h * deviceRatio;
            videoX = (w - videoW) / 2;
            videoY = 0;
          } else if (elemRatio < deviceRatio) {
            // element taller → top/bottom bars
            videoW = w;
            videoH = w / deviceRatio;
            videoX = 0;
            videoY = (h - videoH) / 2;
          }
 
          // convert element coords → coords inside actual video region
          let localX = elemX - videoX;
          let localY = elemY - videoY;
 
          // clamp to video area
          localX = Math.max(0, Math.min(videoW, localX));
          localY = Math.max(0, Math.min(videoH, localY));
 
          // normalize (0–1) inside the video area
          const relX = localX / videoW;
          const relY = localY / videoH;
 
          // map to device coords
          let devX = Math.round(relX * deviceW);
          let devY = Math.round(relY * deviceH);
 
          // simple orientation heuristic, if needed
          const elemPortrait = h >= w;
          const devicePortrait = deviceH >= deviceW;
          const swapAxes = devicePortrait !== elemPortrait;
          if (swapAxes) {
            const tmp = devX;
            devX = devY;
            devY = tmp;
          }
 
          return { x: devX, y: devY };
        };
 
        recorder.setCoordMapper(mapper);
        console.log('[Recorder] mapper installed', {
          deviceW,
          deviceH,
          fromAdb: !!this.deviceResolution,
        });
      } catch (err) {
        console.warn('[Recorder] installCoordMapper error', err);
      }
    };
 
    // initial install
    install();
 
    // observe layout changes so mapping stays correct
    try {
      if (typeof ResizeObserver !== 'undefined') {
        // disconnect previous observer if any
        if (this.resizeObserver) {
          try {
            this.resizeObserver.disconnect();
          } catch (_) {}
        }
 
        this.resizeObserver = new ResizeObserver(() => install());
 
        // observe the element and body (body changes can change layout)
        try {
          this.resizeObserver.observe(element);
        } catch (_) {}
 
        try {
          this.resizeObserver.observe(document.body);
        } catch (_) {}
      } else {
        // fallback
        window.addEventListener('resize', install);
      }
    } catch (e) {
      // fallback to window resize
      window.addEventListener('resize', install);
    }
  }

  public sendMessage(message: ControlMessage): void {
    // Try to record the outgoing control message (non-blocking)
    try {
      const rec = recorder;
      if (rec && typeof (rec as any).pushControlMessage === 'function' && rec.isRecording && rec.isRecording()) {
        try {
          (rec as any).pushControlMessage(message);
        } catch (e) {
          console.warn('[Recorder] pushControlMessage failed', e);
        }
      }
    } catch (e) {
      console.warn('[Recorder] sendMessage integration error', e);
    }

    // forward to existing pipeline
    try {
      this.streamReceiver.sendEvent(message);
    } catch (e) {
      console.error(TAG, 'sendMessage failed', e);
    }
  }

  public getDeviceName(): string {
    return this.deviceName;
  }

  public setHandleKeyboardEvents(enabled: boolean): void {
    if (enabled) {
      KeyInputHandler.addEventListener(this);
    } else {
      KeyInputHandler.removeEventListener(this);
    }
  }

  public onKeyEvent(event: KeyCodeControlMessage): void {
    this.sendMessage(event);
  }

  public sendNewVideoSetting(videoSettings: VideoSettings): void {
    this.requestedVideoSettings = videoSettings;
    this.sendMessage(CommandControlMessage.createSetVideoSettingsCommand(videoSettings));
  }

  public getClientId(): number {
    return this.clientId;
  }

  public getClientsCount(): number {
    return this.clientsCount;
  }

  public getMaxSize(): Size | undefined {
    if (!this.controlButtons) {
      return;
    }

    const body = document.body;
    const width = (body.clientWidth - this.controlButtons.clientWidth) & ~15;
    const height = body.clientHeight & ~15;
    return new Size(width, height);
  }

  private setTouchListeners(player: BasePlayer): void {
    if (this.touchHandler) {
      return;
    }

    this.touchHandler = new FeaturedInteractionHandler(player, this);
  }

  private applyNewVideoSettings(videoSettings: VideoSettings, saveToStorage: boolean): void {
    let fitToScreen = false;
    // TODO: create control (switch/checkbox) instead
    if (videoSettings.bounds && videoSettings.bounds.equals(this.getMaxSize())) {
      fitToScreen = true;
    }

    if (this.player) {
      this.player.setVideoSettings(videoSettings, fitToScreen, saveToStorage);
    }
  }

  public static createEntryForDeviceList(
    descriptor: GoogDeviceDescriptor,
    _blockClass: string,
    fullName: string,
    params: ParamsDeviceTracker,
  ): HTMLElement | DocumentFragment | undefined {
    const hasPid = descriptor.pid !== -1;
    if (hasPid) {
      const configureButtonId = `configure_${Util.escapeUdid(descriptor.udid)}`;
      const e = html`
        <a
          class="control-button"
          href="#"
          id="${configureButtonId}"
          data-udid="${descriptor.udid}"
          data-full-name="${fullName}"
          data-secure="${params.secure}"
          data-hostname="${params.hostname}"
          data-port="${params.port}"
          data-use-proxy="${params.useProxy}"
          title="Configure stream"
          >Configure stream</a
        >
      `;
      const a = e.content.getElementById(configureButtonId);
      a && (a.onclick = this.onConfigureStreamClick);
      return e.content;
    }

    return;
  }

  private static onConfigureStreamClick = (event: MouseEvent): void => {
    const button = event.currentTarget as HTMLAnchorElement;
    const udid = Util.parseStringEnv(button.getAttribute(Attribute.UDID) || '');
    const fullName = button.getAttribute(Attribute.FULL_NAME);
    const secure = Util.parseBooleanEnv(button.getAttribute(Attribute.SECURE) || undefined) || false;
    const hostname = Util.parseStringEnv(button.getAttribute(Attribute.HOSTNAME) || undefined) || '';
    const port = Util.parseIntEnv(button.getAttribute(Attribute.PORT) || undefined);
    const useProxy = Util.parseBooleanEnv(button.getAttribute(Attribute.USE_PROXY) || undefined);

    if (!udid) {
      throw Error(`Invalid udid value: "${udid}"`);
    }

    if (typeof port !== 'number') {
      throw Error(`Invalid port type: ${typeof port}`);
    }

    const tracker = DeviceTracker.getInstance({
      type: 'android',
      secure,
      hostname,
      port,
      useProxy,
    });

    const descriptor = tracker.getDescriptorByUdid(udid);
    if (!descriptor) {
      return;
    }

    event.preventDefault();
    const elements = document.getElementsByName(`${DeviceTracker.AttributePrefixInterfaceSelectFor}${fullName}`);
    if (!elements || !elements.length) {
      return;
    }

    const select = elements[0] as HTMLSelectElement;
    const optionElement = select.options[select.selectedIndex];
    const ws = optionElement.getAttribute(Attribute.URL);
    const name = optionElement.getAttribute(Attribute.NAME);

    if (!ws || !name) {
      return;
    }

    const options: ParamsStreamScrcpy = {
      udid,
      ws,
      player: '',
      action: ACTION.STREAM_SCRCPY,
      secure,
      hostname,
      port,
      useProxy,
    };

    const dialog = new ConfigureScrcpy(tracker, descriptor, options);
    dialog.on('closed', StreamClientScrcpy.onConfigureDialogClosed);
  };

  private static onConfigureDialogClosed = (event: { dialog: ConfigureScrcpy; result: boolean }): void => {
    event.dialog.off('closed', StreamClientScrcpy.onConfigureDialogClosed);
    if (event.result) {
      HostTracker.getInstance().destroy();
    }
  };
}
