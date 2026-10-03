import api from "./client";

export interface ParkHighlight {
  title: string;
  desc: string;
  tag: string;
}

export const fetchHighlights = async () => {
  const { data } = await api.get<ParkHighlight[]>("/park/highlights");
  return data;
};

export const fetchWeather = async () => {
  const { data } = await api.get<{ feel: string; humidity: number; advise: string }>("/park/weather");
  return data;
};
