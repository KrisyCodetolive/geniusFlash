export function formatBytes(bytes: number) {
  if (bytes < 1024) {
    return `${bytes} o`;
  }

  const units = ['Ko', 'Mo', 'Go'];
  let value = bytes / 1024;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

export function formatTime(date: Date) {
  return date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

/** Ajoute le texte en rendant cliquables les liens http(s) ; rien n’est jamais interprété comme du HTML. */
export function appendLinkifiedText(container: HTMLElement, text: string) {
  const urlPattern = /\bhttps?:\/\/[^\s<>"']+/gi;
  let lastIndex = 0;

  for (const match of text.matchAll(urlPattern)) {
    const url = match[0].replace(/[),.;:!?]+$/, '');
    const start = match.index ?? 0;
    container.append(text.slice(lastIndex, start));
    const link = document.createElement('a');
    link.href = url;
    link.textContent = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    container.append(link);
    lastIndex = start + url.length;
  }

  container.append(text.slice(lastIndex));
}
