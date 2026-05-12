export type FetchLike = typeof fetch;

export type FrontendRuntimeConfig = {
  apiBaseUrl?: string;
};

export type SubmitEventLike = {
  preventDefault: () => void;
};
