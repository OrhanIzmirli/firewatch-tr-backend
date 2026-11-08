import { News } from '../types';
import { provinceInTitle } from './newsGeography';
import { NewsKind, newsKind } from './newsKinds';
import { DistrictRef, mentionedDistricts } from '../services/placeMention';
import { withSourceLogo } from './newsSourceLogos';

export type PublicNews = Omit<News, 'image_url' | 'thumbnail_url'> & {
  source_logo_url: string;
  province: string | null;
  thumb_path: string | null;
  kind: NewsKind | null;
};

/** The province a headline is about, directly or through one of its districts. */
export function headlineProvince(title: string, districts: readonly DistrictRef[] = []): string | null {
  const direct = provinceInTitle(title);
  if (direct) return direct;
  const provinces = new Set(mentionedDistricts(title, districts).map((m) => m.district.provinceName));
  return provinces.size === 1 ? [...provinces][0] : null;
}

/**
 * What leaves the API: headline, source and link. Any older client still
 * reads the text fields, so they stay present and empty.
 */
export function toPublicNews(row: News, districts: readonly DistrictRef[] = []): PublicNews {
  const { image_url: _image, thumbnail_url: _thumb, ...rest } = row;
  const province = headlineProvince(row.title, districts);
  const when = row.published_at ?? row.created_at;
  return {
    ...withSourceLogo(rest),
    summary: '',
    body: '',
    highlights: [],
    paragraphs: [],
    province,
    kind: newsKind(row.title),
    thumb_path: province && when ? `/api/news/thumb/${encodeURIComponent(province)}/${new Date(when).toISOString().slice(0, 10)}` : null,
  };
}
