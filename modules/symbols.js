export async function checkLibrary() {
  try {
    const root = await navigator.storage.getDirectory();
    const libDir = await root.getDirectoryHandle('library');
    var count = 0;
    for await (const _ of libDir.entries()) {
      count++;
    }
    return count > 0 ? count : null;
  } catch {
    return null;
  }
}
