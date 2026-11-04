export async function download(id: string) {
  const url = `https://example.com/p/${id}`;
  const started = Date.now(); // ours: timing
  return fetch(url);
}
