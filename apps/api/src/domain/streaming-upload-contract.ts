export interface StreamingMediaUploadInput {
  contentId: string;
  kind: "image" | "thumbnail" | "video";
  mimeType: string;
  contentLength: number;
  body: ReadableStream<Uint8Array>;
  signal?: AbortSignal;
}

export interface StreamingMediaStorage {
  uploadStream(input: {
    key: string;
    body: ReadableStream<Uint8Array>;
    contentType: string;
    contentLength: number;
    signal?: AbortSignal;
  }): Promise<{ bucket: string; key: string }>;
}
