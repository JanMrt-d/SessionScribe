export const MANAGED_PROFILE_NAME = 'SessionScribe'
export const MANAGED_SCENE_COLLECTION_NAME = 'SessionScribe'
export const MANAGED_SCENE_NAME = 'Capture'
export const WINDOW_INPUT_NAME = 'SessionScribe Window'
export const MICROPHONE_INPUT_NAME = 'SessionScribe Microphone'
export const SYSTEM_AUDIO_INPUT_NAME = 'SessionScribe System Audio'

export const REQUIRED_OBS_REQUESTS = [
  'GetVersion',
  'GetProfileList',
  'SetCurrentProfile',
  'CreateProfile',
  'GetProfileParameter',
  'SetProfileParameter',
  'GetSceneCollectionList',
  'SetCurrentSceneCollection',
  'CreateSceneCollection',
  'GetSceneList',
  'GetCurrentProgramScene',
  'CreateScene',
  'SetCurrentProgramScene',
  'GetInputKindList',
  'GetInputList',
  'CreateInput',
  'RemoveInput',
  'GetInputSettings',
  'SetInputSettings',
  'GetInputPropertiesListPropertyItems',
  'PressInputPropertiesButton',
  'GetSpecialInputs',
  'GetInputMute',
  'SetInputMute',
  'SetInputAudioTracks',
  'GetSceneItemId',
  'SetSceneItemEnabled',
  'SetSceneItemTransform',
  'GetSourceActive',
  'GetSourceScreenshot',
  'GetVideoSettings',
  'SetVideoSettings',
  'GetRecordDirectory',
  'SetRecordDirectory',
  'GetStats',
  'GetRecordStatus',
  'StartRecord',
  'StopRecord'
] as const

export const RECORD_STARTED = 'OBS_WEBSOCKET_OUTPUT_STARTED'
export const RECORD_STOPPED = 'OBS_WEBSOCKET_OUTPUT_STOPPED'

export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000
export const RECORD_START_TIMEOUT_MS = 15_000
export const RECORD_STOP_TIMEOUT_MS = 30_000
