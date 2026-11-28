const rawApiUrl = process.env.NEXT_PUBLIC_API_URL ?? "";

export const env = {
  apiUrl: rawApiUrl.replace(/\/+$/, ""),
} as const;
