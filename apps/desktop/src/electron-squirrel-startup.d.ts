// electron-squirrel-startup ships no types. It exports a boolean that is true
// only during Windows Squirrel install/update shortcut events.
declare module 'electron-squirrel-startup' {
  const started: boolean;
  export default started;
}
