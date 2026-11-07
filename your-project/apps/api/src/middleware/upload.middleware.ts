
import multer from "multer";
import path from "node:path";
import fs from "node:fs";

const uploadDir = path.resolve(__dirname, "../../../uploads");

fs.mkdirSync(uploadDir, { recursive: true });

const allowedTypes = [
    "image/jpeg",
    "image/png",
    "application/pdf",
];

const storage = multer.diskStorage({
    destination: (_req, _file, cb) => {
        cb(null, uploadDir);
    },

    filename: (_req, file, cb) => {
        const ext =
            file.mimetype === "image/jpeg" ? ".jpg" :
                file.mimetype === "image/png" ? ".png" :
                    ".pdf";
        cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
    },
});

export const uploadEvidence = multer({
    storage,
    limits: {
        fileSize: 5 * 1024 * 1024,
    },
    fileFilter: (_req, file, cb) => {
        if (allowedTypes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error("Only JPG, PNG and PDF files are allowed"));
        }
    },
});
