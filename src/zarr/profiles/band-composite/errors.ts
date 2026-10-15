export class BandCompositeStoreError extends Error {
  constructor() {
    super("band-composite store — use the band-composite profile");
    this.name = "BandCompositeStoreError";
  }
}
