export const VERSION = "4.2.0-beta.2";
export const APP_NAME = "Jarvis Code";

/**
 * Источник обновлений «из коробки» — вшивается при сборке:
 *   JC_UPDATE_REPO=owner/repo bun scripts/build.ts --release   (GitHub Releases)
 *   JC_UPDATE_URL=https://…/latest.json …                      (свой сервер)
 * Источник, указанный в настройках, важнее.
 */
export const BUILTIN_UPDATE_REPO: string = process.env.JC_UPDATE_REPO ?? "";
export const BUILTIN_UPDATE_URL: string = process.env.JC_UPDATE_URL ?? "";
