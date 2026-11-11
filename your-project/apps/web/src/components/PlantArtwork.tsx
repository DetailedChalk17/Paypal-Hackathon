const HIGH_TRUST_SCORE = 70;

export function PlantArtwork({ trustScore }: { trustScore: number }) {
  const healthy = trustScore >= HIGH_TRUST_SCORE;

  return (
    <svg
      className={`plant-illustration ${healthy ? "plant-illustration--healthy" : "plant-illustration--wilted"}`}
      viewBox="0 0 220 180"
      role="img"
      aria-label={`Trust score ${trustScore} out of 100: ${healthy ? "healthy plant" : "wilted plant"}`}
      xmlns="http://www.w3.org/2000/svg"
    >
      <ellipse className="plant-ground" cx="110" cy="158" rx="66" ry="11" />
      <circle className="plant-detail plant-detail--one" cx="51" cy="112" r="3" />
      <circle className="plant-detail plant-detail--two" cx="170" cy="93" r="2.5" />
      <path className="plant-stem" d="M110 145c1-21-2-42 1-66 1-10 0-19-1-30" />
      <path className="plant-branch" d="M109 111c-15-1-24-9-31-21m34 12c14-2 23-10 29-20m-32-3c-11-3-18-10-22-20m23 10c13-2 21-9 25-18m-26 48c-9 2-17 0-23-4" />
      {healthy ? (
        <g className="plant-growth">
          <path className="plant-leaf" d="M78 92C61 94 51 84 54 68c16-2 29 6 32 21-2 2-5 3-8 3Z" />
          <path className="plant-vein" d="M58 72c9 5 17 10 25 17" />
          <path className="plant-leaf plant-leaf--accent" d="M143 84c15-5 25-16 20-31-15 2-25 12-27 28 2 2 4 3 7 3Z" />
          <path className="plant-vein" d="M158 58c-7 8-14 15-21 22" />
          <path className="plant-leaf plant-leaf--accent" d="M89 66C73 59 69 46 78 33c14 7 20 19 16 33-2 1-4 1-5 0Z" />
          <path className="plant-vein" d="M81 39c5 9 9 17 11 26" />
          <path className="plant-leaf" d="M126 57c5-15 17-22 31-16-3 15-13 24-29 23-1-2-2-4-2-7Z" />
          <path className="plant-vein" d="M151 44c-8 6-16 12-24 18" />
          <path className="plant-leaf" d="M105 48C92 39 90 26 101 15c12 9 16 21 9 34-2 0-4 0-5-1Z" />
          <path className="plant-vein" d="M103 21c3 9 5 18 6 27" />
          <path className="plant-leaf plant-leaf--accent" d="M116 46c1-16 11-26 26-24 1 15-7 26-22 29-2-1-3-3-4-5Z" />
          <path className="plant-vein" d="M136 28c-6 7-12 14-19 20" />
          <path className="plant-leaf plant-leaf--accent" d="M86 111c-13 3-23-2-25-14 12-4 22-1 29 9-1 2-2 4-4 5Z" />
          <path className="plant-vein" d="M67 100c8 2 15 4 23 8" />
        </g>
      ) : (
        <g className="plant-growth">
          <path className="plant-leaf" d="M81 91c-16 4-26-3-27-18 15-4 27 2 32 15-1 1-3 2-5 3Z" />
          <path className="plant-vein" d="M60 77c9 3 17 7 25 12" />
          <path className="plant-leaf plant-leaf--accent" d="M144 83c14 3 22-4 21-18-14-2-24 4-28 17 2 1 4 1 7 1Z" />
          <path className="plant-vein" d="M159 69c-7 4-14 8-21 12" />
          <path className="plant-leaf plant-leaf--accent" d="M91 66C77 57 77 44 87 34c12 9 15 20 9 33-2 0-4 0-5-1Z" />
          <path className="plant-vein" d="M88 40c4 9 7 17 8 26" />
          <path className="plant-leaf" d="M128 57c5-13 16-18 28-12-4 13-13 20-27 19-1-2-1-4-1-7Z" />
          <path className="plant-vein" d="M150 48c-7 5-14 10-21 15" />
          <path className="plant-leaf" d="M105 49c-12-8-12-20-2-29 10 8 13 18 8 30-2 0-4 0-6-1Z" />
          <path className="plant-vein" d="M105 25c3 8 5 16 6 24" />
        </g>
      )}
      <path className="plant-soil" d="M80 139c12-5 47-5 60 0v7H80z" />
      <path className="plant-pot" d="M83 143h54l-7 32H90z" />
      <path className="plant-pot-rim" d="M78 138h64v10H78z" />
      <path className="plant-pot-detail" d="m93 153 3 15m30-15-3 15" />
      <path className="plant-pot-base" d="M88 176h44" />
    </svg>
  );
}
