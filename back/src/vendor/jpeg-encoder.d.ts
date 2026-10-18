export class JPEGEncoder {
  constructor(quality: number);
  encode(image: { width: number; height: number; data: Uint8Array }, quality?: number): Uint8Array;
}
