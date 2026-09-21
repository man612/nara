export type WeatherSnapshot = {
  latitude: number;
  longitude: number;
  timezone: string;
  current: {
    temperatureC: number;
    apparentTemperatureC: number;
    precipitationMm: number;
    weatherCode: number;
    windKph: number;
  };
  today: {
    minTemperatureC: number;
    maxTemperatureC: number;
    precipitationProbabilityPercent: number;
    precipitationMm: number;
  };
  checkedAt: string;
};

export type OpenMeteoWeatherOptions = {
  latitude: number;
  longitude: number;
  timezone: string;
  endpoint?: string;
  fetchImpl?: typeof fetch;
};

function finite(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("Open-Meteo response is missing " + name);
  }
  return value;
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Open-Meteo response is missing " + name);
  }
  return value as Record<string, unknown>;
}

function firstNumber(value: unknown, name: string): number {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("Open-Meteo response is missing " + name);
  }
  return finite(value[0], name);
}

export class OpenMeteoWeatherClient {
  private readonly fetchImpl: typeof fetch;
  private readonly endpoint: string;

  constructor(private readonly options: OpenMeteoWeatherOptions) {
    if (
      !Number.isFinite(options.latitude) ||
      options.latitude < -90 ||
      options.latitude > 90
    ) {
      throw new Error("Weather latitude must be from -90 to 90");
    }
    if (
      !Number.isFinite(options.longitude) ||
      options.longitude < -180 ||
      options.longitude > 180
    ) {
      throw new Error("Weather longitude must be from -180 to 180");
    }
    if (!options.timezone.trim()) {
      throw new Error("Weather timezone is required");
    }
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.endpoint =
      options.endpoint ?? "https://api.open-meteo.com/v1/forecast";
  }

  async current(signal?: AbortSignal): Promise<WeatherSnapshot> {
    const url = new URL(this.endpoint);
    url.searchParams.set("latitude", String(this.options.latitude));
    url.searchParams.set("longitude", String(this.options.longitude));
    url.searchParams.set("timezone", this.options.timezone);
    url.searchParams.set(
      "current",
      [
        "temperature_2m",
        "apparent_temperature",
        "precipitation",
        "weather_code",
        "wind_speed_10m"
      ].join(",")
    );
    url.searchParams.set(
      "daily",
      [
        "temperature_2m_min",
        "temperature_2m_max",
        "precipitation_probability_max",
        "precipitation_sum"
      ].join(",")
    );
    url.searchParams.set("forecast_days", "1");

    const response = await this.fetchImpl(url, { ...(signal ? { signal } : {}) });
    if (!response.ok) {
      throw new Error("Weather request failed: HTTP " + response.status);
    }

    const root = record(await response.json(), "root");
    const current = record(root.current, "current");
    const daily = record(root.daily, "daily");

    return {
      latitude: finite(root.latitude, "latitude"),
      longitude: finite(root.longitude, "longitude"),
      timezone:
        typeof root.timezone === "string"
          ? root.timezone
          : this.options.timezone,
      current: {
        temperatureC: finite(current.temperature_2m, "temperature_2m"),
        apparentTemperatureC: finite(
          current.apparent_temperature,
          "apparent_temperature"
        ),
        precipitationMm: finite(current.precipitation, "precipitation"),
        weatherCode: finite(current.weather_code, "weather_code"),
        windKph: finite(current.wind_speed_10m, "wind_speed_10m")
      },
      today: {
        minTemperatureC: firstNumber(
          daily.temperature_2m_min,
          "temperature_2m_min"
        ),
        maxTemperatureC: firstNumber(
          daily.temperature_2m_max,
          "temperature_2m_max"
        ),
        precipitationProbabilityPercent: firstNumber(
          daily.precipitation_probability_max,
          "precipitation_probability_max"
        ),
        precipitationMm: firstNumber(
          daily.precipitation_sum,
          "precipitation_sum"
        )
      },
      checkedAt: new Date().toISOString()
    };
  }
}

const WEATHER_DESCRIPTIONS_ID: Record<number, string> = {
  0: "cerah",
  1: "sebagian besar cerah",
  2: "berawan sebagian",
  3: "mendung",
  45: "berkabut",
  48: "berkabut tebal",
  51: "gerimis ringan",
  53: "gerimis",
  55: "gerimis lebat",
  61: "hujan ringan",
  63: "hujan",
  65: "hujan lebat",
  71: "salju ringan",
  73: "salju",
  75: "salju lebat",
  80: "hujan singkat ringan",
  81: "hujan singkat",
  82: "hujan singkat lebat",
  95: "badai petir",
  96: "badai petir dengan hujan es ringan",
  99: "badai petir dengan hujan es"
};

export function weatherDescriptionId(code: number): string {
  return WEATHER_DESCRIPTIONS_ID[Math.trunc(code)] ?? "cuaca berubah-ubah";
}

function rounded(value: number): string {
  return Math.round(value).toString();
}

export function describeWeatherId(snapshot: WeatherSnapshot): string {
  const rainChance = Math.round(
    snapshot.today.precipitationProbabilityPercent
  );
  const rain =
    rainChance >= 60
      ? "Peluang hujan cukup tinggi, sekitar " + rainChance + " persen."
      : rainChance >= 30
        ? "Ada kemungkinan hujan sekitar " + rainChance + " persen."
        : "Peluang hujan rendah, sekitar " + rainChance + " persen.";

  return (
    "Cuaca sekarang " +
    weatherDescriptionId(snapshot.current.weatherCode) +
    ", " +
    rounded(snapshot.current.temperatureC) +
    " derajat Celsius, terasa seperti " +
    rounded(snapshot.current.apparentTemperatureC) +
    " derajat. Suhu hari ini sekitar " +
    rounded(snapshot.today.minTemperatureC) +
    " sampai " +
    rounded(snapshot.today.maxTemperatureC) +
    " derajat. " +
    rain
  );
}
