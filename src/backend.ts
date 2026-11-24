import { DESKTOP_PROTOCOL_VERSION } from './shared';

const restartMessage =
  'Quit SQL DB Diff and reopen the updated app. Frontend changes can reload during development, but desktop backend changes require an app restart.';

export function backendVersionCheck(getVersion: () => Promise<unknown>) {
  let checked: Promise<void> | undefined;
  return () =>
    (checked ??= (async () => {
      let version: unknown;
      try {
        version = await getVersion();
      } catch {
        throw new Error(
          `This window is connected to an older or unavailable desktop backend. ${restartMessage}`,
        );
      }
      if (version !== DESKTOP_PROTOCOL_VERSION)
        throw new Error(
          `The interface and desktop backend versions do not match. ${restartMessage}`,
        );
    })());
}

export function databaseList(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((database) => typeof database !== 'string'))
    throw new Error(`The desktop app returned an invalid database list. ${restartMessage}`);
  return value;
}
