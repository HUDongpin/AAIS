type ReplaceableBrowserLocation = Pick<Location, "replace">;

export function replaceAaisBrowserLocation(
  path: string,
  location: ReplaceableBrowserLocation = window.location,
) {
  location.replace(path);
}
