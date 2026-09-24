/** The scanner hands the address back without putting a URL into the route. */
let scanned: string | null = null;

export function setScannedAddress(value: string): void {
  scanned = value;
}

export function takeScannedAddress(): string | null {
  const value = scanned;
  scanned = null;
  return value;
}
