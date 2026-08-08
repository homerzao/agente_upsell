// Criptografia do data channel de WhatsApp Flows (protocolo da Meta, validado
// em produção simulando a Meta ponta a ponta):
// - request: AES key cifrada com RSA-OAEP(sha256) da chave do NÚMERO;
//   payload em aes-128-gcm (auth tag = últimos 16 bytes), IV do request.
// - response: MESMA chave AES, IV INVERTIDO bit a bit, base64(ciphertext+tag)
//   cru no body (sem JSON em volta).
import crypto from 'node:crypto';

export type FlowRequestBody = {
  encrypted_flow_data?: string;
  encrypted_aes_key?: string;
  initial_vector?: string;
};

export type FlowPayload = {
  version?: string;
  action?: string;
  screen?: string;
  flow_token?: string;
  data?: Record<string, unknown>;
};

export function decryptFlowRequest(
  privateKeyPem: string,
  body: FlowRequestBody,
): { aesKey: Buffer; iv: Buffer; payload: FlowPayload } {
  if (!body?.encrypted_flow_data || !body?.encrypted_aes_key || !body?.initial_vector) {
    throw new Error('body do flow incompleto');
  }
  const aesKey = crypto.privateDecrypt(
    {
      key: privateKeyPem,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
    },
    Buffer.from(body.encrypted_aes_key, 'base64'),
  );
  const iv = Buffer.from(body.initial_vector, 'base64');
  const dados = Buffer.from(body.encrypted_flow_data, 'base64');
  const tag = dados.subarray(dados.length - 16); // auth tag = últimos 16 bytes
  const cifrado = dados.subarray(0, dados.length - 16);
  const decipher = crypto.createDecipheriv('aes-128-gcm', aesKey, iv);
  decipher.setAuthTag(tag);
  const claro = Buffer.concat([decipher.update(cifrado), decipher.final()]);
  return { aesKey, iv, payload: JSON.parse(claro.toString('utf8')) };
}

export function encryptFlowResponse(aesKey: Buffer, ivRequest: Buffer, resposta: unknown): string {
  // IV da resposta = IV do request INVERTIDO bit a bit
  const ivResposta = Buffer.from(ivRequest.map((b) => ~b & 0xff));
  const cipher = crypto.createCipheriv('aes-128-gcm', aesKey, ivResposta);
  const cifrado = Buffer.concat([cipher.update(JSON.stringify(resposta), 'utf8'), cipher.final()]);
  return Buffer.concat([cifrado, cipher.getAuthTag()]).toString('base64');
}

// Simula a META cifrando um request — usado nos testes de integração.
export function encryptFlowRequestComoMeta(
  publicKeyPem: string,
  payload: FlowPayload,
): FlowRequestBody & { aesKey: Buffer; iv: Buffer } {
  const aesKey = crypto.randomBytes(16);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-128-gcm', aesKey, iv);
  const cifrado = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return {
    encrypted_flow_data: Buffer.concat([cifrado, cipher.getAuthTag()]).toString('base64'),
    encrypted_aes_key: crypto
      .publicEncrypt(
        { key: publicKeyPem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
        aesKey,
      )
      .toString('base64'),
    initial_vector: iv.toString('base64'),
    aesKey,
    iv,
  };
}

export function decryptFlowResponseComoMeta(aesKey: Buffer, ivRequest: Buffer, bodyBase64: string): unknown {
  const ivResposta = Buffer.from(ivRequest.map((b) => ~b & 0xff));
  const dados = Buffer.from(bodyBase64, 'base64');
  const tag = dados.subarray(dados.length - 16);
  const cifrado = dados.subarray(0, dados.length - 16);
  const decipher = crypto.createDecipheriv('aes-128-gcm', aesKey, ivResposta);
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(cifrado), decipher.final()]).toString('utf8'));
}
