import { describe, expect, test } from "bun:test";
import { scoreLocalizationGap } from "../../src/scoring/localization-gap.ts";

const EN_DESC =
  "The best calorie counter app. Track your meals and reach your goals with a simple workout plan.";
const FR_DESC =
  "La meilleure application pour compter les calories. Suivez vos repas et atteignez vos objectifs avec un plan d'entraînement simple.";
const DE_DESC =
  "Die beste App zum Kalorienzählen. Verfolge deine Mahlzeiten und erreiche deine Ziele mit einem einfachen Trainingsplan.";
const ES_DESC =
  "La mejor aplicación para contar calorías. Registra tus comidas y alcanza tus objetivos con un plan de entrenamiento simple.";
const PT_DESC =
  "O melhor aplicativo para contar calorias. Acompanhe suas refeições e alcance seus objetivos com um plano de treino simples.";
const JA_DESC = "最高のカロリーカウンターアプリです。食事を記録して、シンプルなワークアウトプランで目標を達成しましょう。";
const RU_DESC = "Лучшее приложение для подсчёта калорий. Отслеживайте приёмы пищи и достигайте целей.";

describe("scoreLocalizationGap", () => {
  test("EN description in US market scores 0 (well localized)", () => {
    expect(scoreLocalizationGap({ description: EN_DESC, market: "us" })).toBe(0);
  });

  test("EN description in BR market scores 10 (full gap)", () => {
    expect(scoreLocalizationGap({ description: EN_DESC, market: "br" })).toBe(10);
  });

  test("PT description in BR market scores 0 (well localized)", () => {
    expect(scoreLocalizationGap({ description: PT_DESC, market: "br" })).toBe(0);
  });

  test("FR description in FR market scores 0", () => {
    expect(scoreLocalizationGap({ description: FR_DESC, market: "fr" })).toBe(0);
  });

  test("DE description in DE market scores 0", () => {
    expect(scoreLocalizationGap({ description: DE_DESC, market: "de" })).toBe(0);
  });

  test("ES description in MX market scores 0", () => {
    expect(scoreLocalizationGap({ description: ES_DESC, market: "mx" })).toBe(0);
  });

  test("JA description in JP market scores 0", () => {
    expect(scoreLocalizationGap({ description: JA_DESC, market: "jp" })).toBe(0);
  });

  test("EN description in JP market scores 10", () => {
    expect(scoreLocalizationGap({ description: EN_DESC, market: "jp" })).toBe(10);
  });

  test("RU description in RU market scores 0", () => {
    expect(scoreLocalizationGap({ description: RU_DESC, market: "ru" })).toBe(0);
  });

  test("EN description in unknown market falls back to neutral (5)", () => {
    expect(scoreLocalizationGap({ description: EN_DESC, market: "zz" })).toBe(5);
  });

  test("empty description returns neutral (5)", () => {
    expect(scoreLocalizationGap({ description: "", market: "fr" })).toBe(5);
  });

  test("EN description in GB market scores 0 (English-speaking)", () => {
    expect(scoreLocalizationGap({ description: EN_DESC, market: "gb" })).toBe(0);
  });

  test("PT description in PT market scores 0", () => {
    expect(scoreLocalizationGap({ description: PT_DESC, market: "pt" })).toBe(0);
  });

  test("score is bounded [0, 10]", () => {
    const s = scoreLocalizationGap({ description: EN_DESC, market: "br" });
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThanOrEqual(10);
  });
});
