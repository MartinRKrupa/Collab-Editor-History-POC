const DOCUMENT_NAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export function isDocumentName(value: string): boolean {
  return DOCUMENT_NAME.test(value);
}
