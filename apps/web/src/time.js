// Relative time for the card conversation slice (PORCH-046 ac-5 ReplyItem
// treatment): author, relative time, text. Pure formatting; dateOf keeps
// the header's medium date.

export function dateOf(value) {
  if (!value || Number.isNaN(new Date(value).valueOf())) return '';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(value));
}

export function relativeTime(value, now = Date.now()) {
  if (!value) return '';
  const then = new Date(value).valueOf();
  if (Number.isNaN(then)) return '';
  const seconds = Math.round((now - then) / 1000);
  if (seconds < 60) return 'now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return dateOf(value);
}