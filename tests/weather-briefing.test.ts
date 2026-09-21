import { describe, expect, it } from "vitest";
import {
  describeWeatherId,
  OpenMeteoWeatherClient
} from "../src/briefing/weather.js";

describe("OpenMeteoWeatherClient", () => {
  it("requests only compact current and one-day forecast data", async () => {
    let requested = "";
    const client = new OpenMeteoWeatherClient({
      latitude: -6.99,
      longitude: 110.42,
      timezone: "Asia/Jakarta",
      fetchImpl: (async (input) => {
        requested = String(input);
        return new Response(
          JSON.stringify({
            latitude: -7,
            longitude: 110.4,
            timezone: "Asia/Jakarta",
            current: {
              temperature_2m: 30.1,
              apparent_temperature: 34.2,
              precipitation: 0,
              weather_code: 2,
              wind_speed_10m: 8
            },
            daily: {
              temperature_2m_min: [24],
              temperature_2m_max: [32],
              precipitation_probability_max: [70],
              precipitation_sum: [7]
            }
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }) as typeof fetch
    });

    const snapshot = await client.current();
    expect(requested).toContain("forecast_days=1");
    expect(snapshot.today.precipitationProbabilityPercent).toBe(70);
    expect(describeWeatherId(snapshot)).toContain("Peluang hujan cukup tinggi");
  });
});
