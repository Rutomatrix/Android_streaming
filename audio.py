import os
import pyaudio
from fastapi import FastAPI, HTTPException
from starlette.responses import StreamingResponse, HTMLResponse, FileResponse
from fastapi.staticfiles import StaticFiles
import uvicorn
from fastapi.middleware.cors import CORSMiddleware
app = FastAPI()
# Allow CORS for all origins
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)
script_dir = os.path.dirname(os.path.realpath(__file__))
static_dir = os.path.join(script_dir, "static")
app.mount("/static", StaticFiles(directory=static_dir), name="static")
 
@app.get("/favicon.ico", include_in_schema=False)
async def favicon():
    return FileResponse(os.path.join(static_dir, "favicon.ico"))
 
# Audio settings
FORMAT = pyaudio.paInt16
CHANNELS = 2
RATE = 48000
CHUNK = 32
MIC_INDEX = None
 
audio = pyaudio.PyAudio()
for i in range(audio.get_device_count()):
    info = audio.get_device_info_by_index(i)
    if 'MS2109' in info.get('name', ''):
        MIC_INDEX = i
print("Selected audio device index:", MIC_INDEX)
if MIC_INDEX is None:
    raise RuntimeError("No MS2109 audio device found.")
 
# Global stream for restarting logic
global_stream = {"stream": None}
 
def create_wav_header(rate, channels):
    byte_rate = rate * channels * 2
    header = b'RIFF' + (36).to_bytes(4, 'little') + b'WAVE'
    header += b'fmt ' + (16).to_bytes(4, 'little') + (1).to_bytes(2, 'little')
    header += (channels).to_bytes(2, 'little') + rate.to_bytes(4, 'little')
    header += byte_rate.to_bytes(4, 'little') + (channels * 2).to_bytes(2, 'little') + (16).to_bytes(2, 'little')
    header += b'data' + (0).to_bytes(4, 'little')
    return header
 
def audio_stream():
    if global_stream["stream"] is not None:
        try:
            global_stream["stream"].stop_stream()
            global_stream["stream"].close()
            global_stream["stream"] = None
            print("Stopped previous audio stream.")
        except:
            pass
 
    try:
        stream = audio.open(format=FORMAT, channels=CHANNELS,
                            rate=RATE, input=True,
                            input_device_index=MIC_INDEX,
                            frames_per_buffer=CHUNK)
        global_stream["stream"] = stream
        yield create_wav_header(RATE, CHANNELS)
        while True:
            yield stream.read(CHUNK, exception_on_overflow=False)
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"Audio device error: {e}")
    finally:
        if global_stream["stream"] is not None:
            global_stream["stream"].stop_stream()
            global_stream["stream"].close()
            global_stream["stream"] = None
 
HTML_PAGE = """
<html>
<head>
<title>Live HDMI Audio Stream</title>
</head>

<body>

<h1>Live HDMI Audio Stream</h1>

<button onclick="startAudio()">Start Audio</button>
<p id="status"></p>

<audio id="audioStream" controls></audio>

<script>
function startAudio() {
    const audio = document.getElementById('audioStream');
    const status = document.getElementById('status');

    audio.src = "/audio";
    
    audio.play()
        .then(() => status.innerText = "Playing...")
        .catch(e => status.innerText = "Error: " + e);
}
</script>

</body>
</html>
"""
 
@app.get("/", response_class=HTMLResponse)
async def homepage():
    return HTML_PAGE
 
@app.get("/audio")
async def audio_feed():
    return StreamingResponse(audio_stream(), media_type="audio/wav")
 
if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=7123)