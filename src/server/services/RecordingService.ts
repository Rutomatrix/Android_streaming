// src/server/services/RecordingService.ts
import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
 
const RECORDING_DIR = '/home/rpi/Desktop/ws-scrcpy-0.8.1/dist/recordings';
 
if (!fs.existsSync(RECORDING_DIR)) {
  fs.mkdirSync(RECORDING_DIR, { recursive: true });
  console.log('[RecordingService] created recordings dir:', RECORDING_DIR);
}
 
export class RecordingService {
  static saveRecording(name: string, data: any[]): { ok: boolean; path?: string; error?: string } {
    try {
      if (!name.endsWith('.json')) name = name + '.json';
      const file = path.join(RECORDING_DIR, name);
      fs.writeFileSync(file, JSON.stringify(data || [], null, 2), 'utf8');
      console.log('[RecordingService] saved recording:', file, 'events=', (data || []).length);
      return { ok: true, path: file };
    } catch (err: any) {
      console.error('[RecordingService] saveRecording error', err);
      return { ok: false, error: String(err) };
    }
  }
 
  static listRecordings(): { ok: boolean; recordings?: string[]; error?: string } {
    try {
      const files = fs.readdirSync(RECORDING_DIR).filter((f) => f.endsWith('.json'));
      return { ok: true, recordings: files };
    } catch (err: any) {
      console.error('[RecordingService] listRecordings error', err);
      return { ok: false, error: String(err) };
    }
  }
 
  // Replay using adb commands recorded in file (uses ev.adb field)
  static async replayByAdb(name: string, opts?: { delayMs?: number }): Promise<{ ok: boolean; error?: string }> {
    try {
      if (!name.endsWith('.json')) name = name + '.json';
      const file = path.join(RECORDING_DIR, name);
      if (!fs.existsSync(file)) throw new Error('Recording not found: ' + name);
      const content = JSON.parse(fs.readFileSync(file, 'utf8')) as any[];
      if (!Array.isArray(content) || content.length === 0) {
        throw new Error('Recording empty or invalid format');
      }
      content.sort((a: any, b: any) => (a.timestamp || 0) - (b.timestamp || 0));
      console.log('[RecordingService] replaying', file, 'events=', content.length, 'delayMs=', opts?.delayMs ?? 120);
      for (const ev of content) {
        if (!ev || !ev.adb) {
          // skip events that do not map to adb (e.g. pointermove metadata)
          continue;
        }
        try {
          await RecordingService.execCommand(ev.adb);
        } catch (e) {
          console.warn('[RecordingService] adb exec error, continuing', ev.adb, e);
        }
        await RecordingService.sleep(opts?.delayMs ?? 120);
      }
      return { ok: true };
    } catch (err: any) {
      console.error('[RecordingService] replayByAdb error', err);
      return { ok: false, error: String(err) };
    }
  }
 
  private static execCommand(cmd: string): Promise<void> {
    return new Promise((resolve) => {
      exec(cmd, { maxBuffer: 1024 * 1024 }, (err) => {
        if (err) {
          console.warn('[RecordingService] exec failed', cmd, String(err));
        }
        resolve();
      });
    });
  }
 
  private static sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}