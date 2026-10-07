export abstract class ProfilePhotoStorage {
  abstract save(bytes: Buffer): Promise<string>;
  abstract read(key: string): Promise<Buffer>;
  abstract delete(key: string): Promise<void>;
}
