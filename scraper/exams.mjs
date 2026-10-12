export const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

// [year, round, tistory post id] — from the index table on https://chobopark.tistory.com/562
const LIST = [
  [2020, 1, 196], [2020, 2, 195], [2020, 3, 194], [2020, 4, 192],
  [2021, 1, 191], [2021, 2, 210], [2021, 3, 217],
  [2022, 1, 271], [2022, 2, 423], [2022, 3, 424],
  [2023, 1, 372], [2023, 2, 420], [2023, 3, 453],
  [2024, 1, 476], [2024, 2, 483], [2024, 3, 495],
  [2025, 1, 540], [2025, 2, 554], [2025, 3, 558],
  [2026, 1, 561], [2026, 2, 562],
];

export const EXAMS = LIST.map(([year, round, post]) => ({
  id: `${year}-${round}`,
  year,
  round,
  post,
  source: `https://chobopark.tistory.com/${post}`,
}));
