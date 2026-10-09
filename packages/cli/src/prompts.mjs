// Non-interactive prompt helpers for the bootstrap driver (CLI use; the
// remote path is the mobile-web page the hub serves at /bootstrap).
import readline from "node:readline/promises";

export function printer() {
  return (message) => process.stdout.write(message + "\n");
}

export async function ask(question, fallback = null) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(question);
    return answer.trim() === "" ? fallback : answer.trim();
  } finally {
    rl.close();
  }
}