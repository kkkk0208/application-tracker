export const MUTATION_MESSAGE = "application-tracker-mutation";

export async function requestStorageMutation(mutation) {
  const response = await chrome.runtime.sendMessage({ type: MUTATION_MESSAGE, mutation });
  if (!response?.ok) throw new Error(response?.error || "保存未完成，请刷新插件后重试");
  return response.value;
}
