export const SERVER_PACKAGE = 'com.genymobile.scrcpy.Server';
export const SERVER_PORT = 8886;
export const SERVER_VERSION = '3.3.3';
export const SCRCPY_SCID = '00000001'; // fixed or generate random hex per session
 
export const LOG_LEVEL = 'log_level=info';
 
const ARGUMENTS = [
    SERVER_VERSION,
    `scid=${SCRCPY_SCID}`,
    LOG_LEVEL,
    'tunnel_forward=true',
    'video_bit_rate=8000000',
    'max_size=0',
    'video=true',
    'audio=false',
];
 
export const SERVER_PROCESS_NAME = 'app_process';
 
export const ARGS_STRING = `/ ${SERVER_PACKAGE} ${ARGUMENTS.join(' ')}`;