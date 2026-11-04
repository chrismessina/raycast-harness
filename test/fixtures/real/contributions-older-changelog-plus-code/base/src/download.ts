export async function download(id: string) {
  const url = `https://example.com/p/${id}`;
  return fetch(url);
}
