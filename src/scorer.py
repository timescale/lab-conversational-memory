"""LoCoMo QA scorer — called as subprocess from evaluate.ts.

Reads JSON array of {prediction, answer, category} on stdin.
Writes JSON array of {f1, em} to stdout.

Uses the exact same scoring logic as LoCoMo's evaluation.py.
"""

import json
import sys
import string
import numpy as np
from collections import Counter
from nltk.stem import PorterStemmer

ps = PorterStemmer()


def normalize_answer(s):
    s = s.replace(",", "")

    def remove_articles(text):
        import re
        return re.sub(r"\b(a|an|the|and)\b", " ", text)

    def white_space_fix(text):
        return " ".join(text.split())

    def remove_punc(text):
        exclude = set(string.punctuation)
        return "".join(ch for ch in text if ch not in exclude)

    def lower(text):
        return text.lower()

    return white_space_fix(remove_articles(remove_punc(lower(s))))


def exact_match_score(prediction, ground_truth):
    return set(normalize_answer(prediction).split()) == set(
        normalize_answer(ground_truth).split()
    )


def f1_score(prediction, ground_truth):
    prediction_tokens = [
        ps.stem(w) for w in normalize_answer(prediction).split()
    ]
    ground_truth_tokens = [
        ps.stem(w) for w in normalize_answer(ground_truth).split()
    ]
    common = Counter(prediction_tokens) & Counter(ground_truth_tokens)
    num_same = sum(common.values())
    if num_same == 0:
        return 0
    precision = 1.0 * num_same / len(prediction_tokens)
    recall = 1.0 * num_same / len(ground_truth_tokens)
    f1 = (2 * precision * recall) / (precision + recall)
    return f1


def f1_multi(prediction, ground_truth):
    predictions = [p.strip() for p in prediction.split(",")]
    ground_truths = [g.strip() for g in ground_truth.split(",")]
    return float(
        np.mean(
            [
                max([f1_score(p, gt) for p in predictions])
                for gt in ground_truths
            ]
        )
    )


def score_qa(prediction, answer, category):
    if category == 5:
        lower = prediction.lower()
        match = (
            1.0
            if "no information available" in lower or "not mentioned" in lower
            else 0.0
        )
        return {"f1": match, "em": match}

    if category == 3:
        answer = answer.split(";")[0].strip()

    if category == 1:
        f1 = f1_multi(prediction, answer)
    else:
        f1 = f1_score(prediction, answer)

    em = 1.0 if exact_match_score(prediction, answer) else 0.0
    return {"f1": round(f1, 6), "em": em}


def main():
    items = json.loads(sys.stdin.read())
    results = []
    for item in items:
        result = score_qa(str(item["prediction"]), str(item["answer"]), item["category"])
        results.append(result)
    json.dump(results, sys.stdout)


if __name__ == "__main__":
    main()
