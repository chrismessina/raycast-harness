export async function download(id: string) {
  const url = `https://example.com/p/${id}`;
  if (!/^[A-Za-z0-9_-]{11}$/.test(id)) throw new Error("bad id: " + id); // contributor fix
  return fetch(url);
}
