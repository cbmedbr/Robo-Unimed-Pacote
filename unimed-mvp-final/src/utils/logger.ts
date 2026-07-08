import pino from "pino";

const logLevel = process.env.LOG_LEVEL || "info";

export const logger = pino({
  level: logLevel,
  transport: {
    target: "pino-pretty",
    options: {
      colorize: true,
      translateTime: "HH:MM:ss.l",
      ignore: "pid,hostname",
    },
  },
  // Redact campos sensíveis
  redact: {
    paths: [
      "senha",
      "password",
      "*.senha",
      "*.password",
      "paciente.telefone",
      "paciente.email",
      "*.cpf",
    ],
    censor: "[REDACTED]",
  },
});

export function logEtapa(etapa: string, status: string, dados?: Record<string, unknown>) {
  logger.info({ etapa, status, ...dados });
}
