export const storage = {
  get<T>(key: string, fallback: T): T {
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : fallback;
    } catch (e) {
      return fallback;
    }
  },
  set<T>(key: string, value: T) {
    localStorage.setItem(key, JSON.stringify(value));
  },
  remove(key: string) {
    localStorage.removeItem(key);
  }
};
