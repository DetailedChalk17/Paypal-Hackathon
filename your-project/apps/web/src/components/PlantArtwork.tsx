const HIGH_TRUST_SCORE = 70;

export function PlantArtwork({ trustScore }: { trustScore: number }) {
  const healthy = trustScore >= HIGH_TRUST_SCORE;
  return (
    <svg
      className={`plant-illustration ${healthy ? "plant-illustration--healthy" : "plant-illustration--wilted"}`}
      viewBox="0 0 180 140"
      role="img"
      aria-label={`Trust score ${trustScore} out of 100: ${healthy ? "healthy plant" : "wilted plant"}`}
    >
      <ellipse className="plant-ground" cx="90" cy="119" rx="54" ry="9" />
      {healthy ? (
        <g className="plant-growth">
          <path className="plant-stem" d="M90 111C89 87 92 61 90 30" />
          <path className="plant-branch" d="M90 83C76 80 66 72 61 60M91 72c14-3 23-11 27-23M90 58c-12-5-17-12-18-22M91 48c11-4 17-11 19-20" />
          <path className="plant-leaf" d="M63 63c-13 0-20-9-19-21 13-1 22 6 25 19-2 1-4 2-6 2Z" />
          <path className="plant-leaf" d="M115 52c12-2 18-11 15-23-13 1-21 9-22 22 2 1 4 1 7 1Z" />
          <path className="plant-leaf" d="M74 39c-12-4-16-14-11-25 12 4 18 13 16 26-2 0-4 0-5-1Z" />
          <path className="plant-leaf" d="M108 31c9-8 9-19 1-28-10 8-12 18-5 29 1 0 3 0 4-1Z" />
          <path className="plant-leaf" d="M98 68c8-9 18-9 26-2-8 9-17 11-27 5 0-1 0-2 1-3Z" />
        </g>
      ) : (
        <g className="plant-growth">
          <path className="plant-stem" d="M90 111c3-16 13-23 8-36-5-13 7-20 1-31-3-6-4-11-4-17" />
          <path className="plant-branch" d="M96 83c-12 1-20-3-26-11M99 68c11 1 18-3 23-10M98 54c-10-1-15-6-19-14" />
          <path className="plant-leaf" d="M72 74c-12 4-21-2-22-14 12-4 22 0 27 11-1 1-3 2-5 3Z" />
          <path className="plant-leaf" d="M117 60c12 5 20-1 21-13-12-5-22-1-27 10 2 1 4 2 6 3Z" />
          <path className="plant-leaf" d="M82 42c-11 2-18-4-18-16 12-2 21 3 24 14-2 1-4 2-6 2Z" />
          <path className="plant-leaf" d="M95 31c7-8 6-17-2-25-9 8-10 18-3 28 2-1 3-2 5-3Z" />
        </g>
      )}
      <path className="plant-pot" d="M66 103h48l-7 29H73l-7-29Z" />
      <path className="plant-pot-rim" d="M63 100h54v8H63z" />
    </svg>
  );
}
