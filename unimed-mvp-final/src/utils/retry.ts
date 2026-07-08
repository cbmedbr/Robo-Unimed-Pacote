import { logger } from "./logger";

/**
 * Executa uma função com retry exponencial.
 */
export async function comRetry<T>(
  fn: () => Promise<T>,
  opcoes: {
    maxTentativas?: number;
    delayInicialMs?: number;
    descricao?: string;
  } = {}
): Promise<T> {
  const max = opcoes.maxTentativas ?? 3;
  const delayInicial = opcoes.delayInicialMs ?? 1000;
  const desc = opcoes.descricao ?? "operação";

  let ultimoErro: unknown;

  for (let tentativa = 1; tentativa <= max; tentativa++) {
    try {
      return await fn();
    } catch (err) {
      ultimoErro = err;
      if (tentativa < max) {
        const delay = delayInicial * Math.pow(2, tentativa - 1);
        logger.warn(
          { tentativa, max, delay, err: (err as Error).message, desc },
          "tentativa falhou, fazendo retry"
        );
        await new Promise((r) => setTimeout(r, delay));
      } else {
        logger.error(
          { tentativa, max, err: (err as Error).message, desc },
          "todas as tentativas falharam"
        );
      }
    }
  }

  throw ultimoErro;
}

/**
 * Aguarda condição true com timeout, sem usar waitForTimeout.
 */
export async function aguardarCondicao(
  condicao: () => Promise<boolean>,
  timeoutMs: number = 10000,
  intervaloMs: number = 200
): Promise<boolean> {
  const inicio = Date.now();
  while (Date.now() - inicio < timeoutMs) {
    if (await condicao()) return true;
    await new Promise((r) => setTimeout(r, intervaloMs));
  }
  return false;
}
