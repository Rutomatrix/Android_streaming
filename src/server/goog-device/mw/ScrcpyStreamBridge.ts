import net from 'net';
import WS from 'ws';
import Util from '../../../app/Util';
 
const MAGIC_BYTES_INITIAL = Buffer.from(Util.stringToUtf8ByteArray('scrcpy_initial'));
const DEVICE_NAME_FIELD_LENGTH = 64;
 
// v3.3.3 video socket sequence:
// 1 byte  dummy
// 64 bytes device name
// 12 bytes codec meta: codecId(4) + width(4) + height(4)
const HEADER_LENGTH = 1 + 64 + 12; // = 77 bytes total
 
export class ScrcpyStreamBridge {
    private headerParsed = false;
    private buffer = Buffer.alloc(0);
 
    // v3.x packet header stripping
    private packetBuffer = Buffer.alloc(0);
    private static readonly PACKET_HEADER_LENGTH = 12; // 8 bytes PTS + 4 bytes size
 
    constructor(private ws: WS, private videoSocket: net.Socket, private controlSocket: net.Socket) {
        this.videoSocket.on('data', (data: Buffer) => this.onData(data));
 
        this.videoSocket.on('close', () => {
            if (this.ws.readyState === this.ws.OPEN) this.ws.close(1000);
            this.controlSocket.destroy();
        });
 
        this.videoSocket.on('error', (e: Error) => {
            console.error('[ScrcpyStreamBridge] Video socket error:', e.message);
            if (this.ws.readyState === this.ws.OPEN) this.ws.close(4011, e.message);
        });
 
        // Browser → Device: route control messages to control socket
        this.ws.on('message', (data: WS.Data) => {
            if (this.controlSocket.writable) {
                this.controlSocket.write(data as Buffer);
            }
        });
 
        this.ws.on('close', () => {
            this.videoSocket.destroy();
            this.controlSocket.destroy();
        });
    }
 
    private onData(data: Buffer): void {
        // ── Step 1: Parse the initial connection header ──────────────────────
        if (!this.headerParsed) {
            this.buffer = Buffer.concat([this.buffer, data]);
 
            if (this.buffer.length < HEADER_LENGTH) {
                console.log(`[ScrcpyStreamBridge] Buffering header: ${this.buffer.length}/${HEADER_LENGTH} bytes`);
                return;
            }
 
            // Parse header
            let offset = 0;
            const dummyByte = this.buffer[0];
            offset += 1;
 
            const deviceNameRaw = this.buffer.slice(offset, offset + DEVICE_NAME_FIELD_LENGTH);
            offset += DEVICE_NAME_FIELD_LENGTH;
 
            const codecId = this.buffer.readUInt32BE(offset); offset += 4;
            const width   = this.buffer.readUInt32BE(offset); offset += 4;
            const height  = this.buffer.readUInt32BE(offset); offset += 4;
 
            const remaining = this.buffer.slice(offset);
            const deviceNameStr = deviceNameRaw.toString('utf8').replace(/\0/g, '');
 
            console.log(`[ScrcpyStreamBridge] dummy=0x${dummyByte.toString(16)} device="${deviceNameStr}" codec=0x${codecId.toString(16)} ${width}x${height}`);
 
            // Build ws-scrcpy initial packet
            const DISPLAY_INFO_LENGTH = 24;
            const totalSize =
                MAGIC_BYTES_INITIAL.length +
                DEVICE_NAME_FIELD_LENGTH +
                4 +                   // displaysCount
                DISPLAY_INFO_LENGTH + // displayInfo
                4 +                   // connectionCount
                4 +                   // screenInfoLen
                4 +                   // videoSettingsLen
                4 +                   // encodersCount
                4;                    // clientId
 
            const packet = Buffer.alloc(totalSize);
            let pOffset = 0;
 
            MAGIC_BYTES_INITIAL.copy(packet, pOffset);
            pOffset += MAGIC_BYTES_INITIAL.length;
 
            deviceNameRaw.copy(packet, pOffset);
            pOffset += DEVICE_NAME_FIELD_LENGTH;
 
            packet.writeInt32BE(1, pOffset); pOffset += 4;        // displaysCount = 1
            packet.writeInt32BE(0, pOffset); pOffset += 4;        // displayId = 0
            packet.writeInt32BE(width, pOffset); pOffset += 4;    // width
            packet.writeInt32BE(height, pOffset); pOffset += 4;   // height
            packet.writeInt32BE(0, pOffset); pOffset += 4;        // rotation
            packet.writeInt32BE(0, pOffset); pOffset += 4;        // layerStack
            packet.writeInt32BE(0, pOffset); pOffset += 4;        // flags
            packet.writeInt32BE(1, pOffset); pOffset += 4;        // connectionCount
            packet.writeInt32BE(0, pOffset); pOffset += 4;        // screenInfoLen = 0
            packet.writeInt32BE(0, pOffset); pOffset += 4;        // videoSettingsLen = 0
            packet.writeInt32BE(0, pOffset); pOffset += 4;        // encodersCount = 0
            packet.writeInt32BE(0, pOffset);                      // clientId = 0
 
            this.headerParsed = true;
            this.buffer = Buffer.alloc(0);
 
            console.log(`[ScrcpyStreamBridge] Sending initial packet (${packet.length} bytes) to browser`);
            if (this.ws.readyState === this.ws.OPEN) {
                this.ws.send(packet);
            }
 
            // Feed any leftover bytes into the packet parser
            if (remaining.length > 0) {
                console.log(`[ScrcpyStreamBridge] Feeding ${remaining.length} remaining bytes into packet parser`);
                this.parsePackets(remaining);
            }
            return;
        }
 
        // ── Step 2: Strip v3.x 12-byte packet headers, forward raw NAL units ─
        this.parsePackets(data);
    }
 
    /**
     * Buffers incoming data and extracts raw H264 NAL units by stripping the
     * scrcpy v3.x per-packet header:
     *   8 bytes — PTS (presentation timestamp, BigUInt64BE)
     *   4 bytes — payload size (UInt32BE)
     *   N bytes — H264 NAL data  ← this is what the browser decoder needs
     */
    private parsePackets(data: Buffer): void {
        this.packetBuffer = Buffer.concat([this.packetBuffer, data]);
 
        while (this.packetBuffer.length >= ScrcpyStreamBridge.PACKET_HEADER_LENGTH) {
            const pts        = this.packetBuffer.readBigUInt64BE(0); // 8 bytes
            const packetSize = this.packetBuffer.readUInt32BE(8);    // 4 bytes
            const totalNeeded = ScrcpyStreamBridge.PACKET_HEADER_LENGTH + packetSize;
 
            if (this.packetBuffer.length < totalNeeded) {
                // Incomplete packet — wait for more data
                break;
            }
 
            const nalData = this.packetBuffer.slice(ScrcpyStreamBridge.PACKET_HEADER_LENGTH, totalNeeded);
            this.packetBuffer = this.packetBuffer.slice(totalNeeded);
 
            console.log(`[ScrcpyStreamBridge] NAL packet: pts=${pts} size=${packetSize} first4=${nalData.slice(0, 4).toString('hex')}`);
 
            if (this.ws.readyState === this.ws.OPEN) {
                this.ws.send(nalData);
            }
        }
    }
}