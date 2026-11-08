import { assessWildfire } from '../utils/wildfireRelevance';
import { mentionedCities } from './officialStatusExtractor';
import { DistrictRef, mentionedDistricts, singleDistrict } from './placeMention';
import { canonicalProvinceNames } from './provinces';

/**
 * "Haberlerde doğrulandı": a wrong match is worse than none, so every gate
 * refuses when in doubt. An article must be a forest-fire story, name
 * exactly one province, the incident's, and exactly one district in it,
 * whose centre is within NEWS_MATCH_RADIUS_KM of the incident, published
 * within a Turkish calendar day of the detections.
 *
 * Related-news lists use the same story and province gates, without the
 * district and distance ones.
 */

export const NEWS_MATCH_RADIUS_KM = 15;
export const NEWS_MATCH_DAY_WINDOW = 1;

export interface MatchArticle {
  id: number;
  title: string;
  summary: string | null;
  publishedAt: Date;
}

export interface MatchIncident {
  id: number;
  city: string | null;
  lat: number;
  lng: number;
  firstAt: Date;
  lastAt: Date;
}

export interface MatchContext {
  cityNames: readonly string[];
  districts: readonly DistrictRef[];
}

export function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(bLat - aLat);
  const dLng = rad(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

/** Day number on the Turkish calendar (UTC+3, no DST). */
export function turkeyDay(d: Date): number {
  return Math.floor((d.getTime() + 3 * 3_600_000) / 86_400_000);
}

export function withinDayWindow(published: Date, first: Date, last: Date): boolean {
  const day = turkeyDay(published);
  return day >= turkeyDay(first) - NEWS_MATCH_DAY_WINDOW && day <= turkeyDay(last) + NEWS_MATCH_DAY_WINDOW;
}

/** A forest-fire story that names this one province and no other. */
export function isStoryAboutProvince(article: MatchArticle, province: string, cityNames: readonly string[]): boolean {
  const text = `${article.title} ${article.summary ?? ''}`;
  const verdict = assessWildfire(article.title, text);
  if (!verdict.wildfire || verdict.basis !== 'strong') return false;
  const named = canonicalProvinceNames(mentionedCities(text, [...cityNames]));
  return named.length === 1 && named[0] === province;
}

export function isForestFireStory(article: MatchArticle): boolean {
  const verdict = assessWildfire(article.title, `${article.title} ${article.summary ?? ''}`);
  return verdict.wildfire && verdict.basis === 'strong';
}

/** Distance in km when the article confirms this incident, otherwise null. */
export function confirmationDistanceKm(
  incident: MatchIncident,
  article: MatchArticle,
  ctx: MatchContext
): number | null {
  if (!incident.city) return null;
  if (!withinDayWindow(article.publishedAt, incident.firstAt, incident.lastAt)) return null;
  if (!isStoryAboutProvince(article, incident.city, ctx.cityNames)) return null;
  const text = `${article.title} ${article.summary ?? ''}`;
  const mention = singleDistrict(mentionedDistricts(text, ctx.districts, [incident.city]));
  if (mention === null || mention.district.provinceName !== incident.city) return null;
  const km = haversineKm(incident.lat, incident.lng, mention.district.lat, mention.district.lng);
  return km <= NEWS_MATCH_RADIUS_KM ? km : null;
}

/**
 * incident id -> article id. An article confirms only its closest incident,
 * and an incident takes its closest article; on a tie, nothing.
 */
export function matchIncidentsToNews(
  incidents: readonly MatchIncident[],
  articles: readonly MatchArticle[],
  ctx: MatchContext
): Map<number, number> {
  const bestForArticle = new Map<number, { incident: number; km: number; tied: boolean }>();
  for (const article of articles) {
    for (const incident of incidents) {
      const km = confirmationDistanceKm(incident, article, ctx);
      if (km === null) continue;
      const best = bestForArticle.get(article.id);
      if (!best || km < best.km) bestForArticle.set(article.id, { incident: incident.id, km, tied: false });
      else if (km === best.km) best.tied = true;
    }
  }
  const bestForIncident = new Map<number, { article: number; km: number }>();
  for (const [article, best] of bestForArticle) {
    if (best.tied) continue;
    const current = bestForIncident.get(best.incident);
    if (!current || best.km < current.km) bestForIncident.set(best.incident, { article, km: best.km });
  }
  return new Map([...bestForIncident].map(([incident, b]) => [incident, b.article]));
}
