const { getFirestore } = require("./firebase-admin");

async function safeLoadLearningContext() {
  try {
    const db = getFirestore();
    const snap = await db.collection("learning").doc("global").get();
    const data = snap.exists ? snap.data() || {} : {};
    let total = Number(data.total || 0);
    let wins = Number(data.wins || 0);
    let topLossReasons = Array.isArray(data.topLossReasons)
      ? data.topLossReasons.slice(0, 8)
      : [];
    const topWinPatterns = Array.isArray(data.topWinPatterns)
      ? data.topWinPatterns.slice(0, 8)
      : [];

    if (!total || topLossReasons.length === 0) {
      const feedbackSnap = await db
        .collection("learning_feedback")
        .orderBy("createdAt", "desc")
        .limit(250)
        .get();
      const reasonCounts = new Map();
      total = feedbackSnap.size;
      wins = 0;
      feedbackSnap.docs.forEach((doc) => {
        const row = doc.data() || {};
        if (String(row.outcome || "") === "win") {
          wins += 1;
        }
        if (String(row.outcome || "") === "loss") {
          const reason = String(row.reason || "").trim();
          if (reason) {
            reasonCounts.set(reason, Number(reasonCounts.get(reason) || 0) + 1);
          }
        }
      });
      topLossReasons = [...reasonCounts.entries()]
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 8);
    }

    const latestModelLessons = Array.isArray(data.latestModelLessons)
      ? data.latestModelLessons
          .map((item) => String(item?.lesson || "").trim())
          .filter(Boolean)
          .slice(0, 6)
      : [];

    // Enhanced: timeframe and direction stats
    const timeframeStats = data.timeframeStats || {};
    const directionStats = data.directionStats || {};
    const currentStreak = Number(data.currentStreak || 0);
    const currentStreakType = String(data.currentStreakType || "");
    const bestWinStreak = Number(data.bestWinStreak || 0);
    const worstLossStreak = Number(data.worstLossStreak || 0);

    return {
      total,
      winRate: total > 0 ? Number(((wins / total) * 100).toFixed(2)) : 0,
      topLossReasons,
      topWinPatterns,
      latestModelLessons,
      timeframeStats,
      directionStats,
      currentStreak,
      currentStreakType,
      bestWinStreak,
      worstLossStreak,
    };
  } catch {
    return {
      total: 0,
      winRate: 0,
      topLossReasons: [],
      topWinPatterns: [],
      latestModelLessons: [],
      timeframeStats: {},
      directionStats: {},
      currentStreak: 0,
      currentStreakType: "",
      bestWinStreak: 0,
      worstLossStreak: 0,
    };
  }
}

function appendLearningContext(prompt, context) {
  const reasons = Array.isArray(context?.topLossReasons)
    ? context.topLossReasons.slice(0, 3)
    : [];
  const wins = Array.isArray(context?.topWinPatterns)
    ? context.topWinPatterns.slice(0, 3)
    : [];
  const lessons = Array.isArray(context?.latestModelLessons)
    ? context.latestModelLessons.slice(0, 3)
    : [];
  const tfStats = context?.timeframeStats || {};
  const dirStats = context?.directionStats || {};

  const sections = [];

  // Main header
  sections.push(
    "Global Learning Memory (from previous analyses across all users):",
  );
  sections.push(
    `Historical samples: ${Number(context?.total || 0)}, win rate: ${Number(context?.winRate || 0)}%`,
  );

  // Streak info
  if (context?.currentStreak > 0 && context?.currentStreakType) {
    sections.push(
      `Current streak: ${context.currentStreak} consecutive ${context.currentStreakType.toUpperCase()}s.`,
    );
  }
  if (context?.worstLossStreak > 2) {
    sections.push(
      `Worst loss streak ever: ${context.worstLossStreak}. Be cautious about marginal setups.`,
    );
  }

  // Timeframe performance
  const tfLines = Object.entries(tfStats)
    .filter(([, stats]) => (stats.wins || 0) + (stats.losses || 0) >= 2)
    .map(([tf, stats]) => {
      const total = (stats.wins || 0) + (stats.losses || 0);
      const wr = total > 0 ? ((stats.wins / total) * 100).toFixed(0) : 0;
      return `${tf}: ${wr}% win rate (${stats.wins}W/${stats.losses}L)`;
    });
  if (tfLines.length > 0) {
    sections.push("Performance by timeframe:");
    sections.push(tfLines.join(", "));
  }

  // Direction performance
  const dirLines = Object.entries(dirStats)
    .filter(([key]) => key === "buy" || key === "sell")
    .filter(([, stats]) => (stats.wins || 0) + (stats.losses || 0) >= 2)
    .map(([dir, stats]) => {
      const total = (stats.wins || 0) + (stats.losses || 0);
      const wr = total > 0 ? ((stats.wins / total) * 100).toFixed(0) : 0;
      return `${dir.toUpperCase()}: ${wr}% win rate (${stats.wins}W/${stats.losses}L)`;
    });
  if (dirLines.length > 0) {
    sections.push("Performance by direction:");
    sections.push(dirLines.join(", "));
  }

  if (wins.length > 0) {
    const winBlock = wins
      .map(
        (item, index) =>
          `${index + 1}. ${String(item?.reason || "").trim()} (count=${Number(item?.count || 0)})`,
      )
      .filter((line) => line.includes(".") && line.length > 6)
      .join("\n");
    if (winBlock) {
      sections.push("Successful patterns to preserve:");
      sections.push(winBlock);
    }
  }

  // Loss reasons
  if (reasons.length > 0) {
    const reasonBlock = reasons
      .map(
        (item, index) =>
          `${index + 1}. ${String(item?.reason || "").trim()} (count=${Number(item?.count || 0)})`,
      )
      .filter((line) => line.includes(".") && line.length > 6)
      .join("\n");
    if (reasonBlock) {
      sections.push("Avoid repeating these common failure patterns:");
      sections.push(reasonBlock);
    }
  }

  // Model lessons
  if (lessons.length > 0) {
    sections.push("Latest model-improvement notes:");
    sections.push(
      lessons.map((item, index) => `${index + 1}. ${item}`).join("\n"),
    );
  }

  if (sections.length <= 2) {
    return prompt;
  }

  sections.push(
    "Apply this memory as hard risk filters when generating the final decision.",
  );
  return [prompt, "", ...sections].join("\n");
}

module.exports = { safeLoadLearningContext, appendLearningContext };
