"use strict";

const http = require("http");
const crypto = require("crypto");
const path = require("path");
const Busboy = require("busboy");
const WebSocket = require("ws");
const { createClient } = require("@supabase/supabase-js");

/*
=========================================================
 CONFIG
=========================================================
*/

const PORT =
    Number(
        process.env.PORT || 10000
    );

const SUPABASE_URL =
    process.env.SUPABASE_URL;

const SUPABASE_SECRET_KEY =
    process.env.SUPABASE_SECRET_KEY;

const GITHUB_TOKEN =
    process.env.GITHUB_TOKEN;

const GITHUB_OWNER =
    "davidtytytutu-lgtm";

const GITHUB_REPO =
    "dreamcore";

const GITHUB_BRANCH =
    "main";

const CHAT_LOG_LIMIT =
    15 * 1024 * 1024;

const UPLOAD_LIMIT =
    25 * 1024 * 1024;

const MESSAGE_LIMIT =
    500;

const USERNAME_MIN =
    3;

const USERNAME_MAX =
    24;


/*
=========================================================
 VERIFICATION
=========================================================
*/

if (!SUPABASE_URL) {

    console.error(
        "[ERROR] SUPABASE_URL missing"
    );

    process.exit(1);

}

if (!SUPABASE_SECRET_KEY) {

    console.error(
        "[ERROR] SUPABASE_SECRET_KEY missing"
    );

    process.exit(1);

}

if (!GITHUB_TOKEN) {

    console.error(
        "[ERROR] GITHUB_TOKEN missing"
    );

    process.exit(1);

}


/*
=========================================================
 SUPABASE
=========================================================
*/

const supabase =
    createClient(
        SUPABASE_URL,
        SUPABASE_SECRET_KEY,
        {
            auth: {
                autoRefreshToken: false,
                persistSession: false
            }
        }
    );


/*
=========================================================
 GITHUB API
=========================================================
*/

const GITHUB_API =
    "https://api.github.com";


function githubHeaders() {

    return {

        "Authorization":
            `Bearer ${GITHUB_TOKEN}`,

        "Accept":
            "application/vnd.github+json",

        "X-GitHub-Api-Version":
            "2022-11-28",

        "User-Agent":
            "Dreamcore-Server"

    };

}


async function githubRequest(
    endpoint,
    options = {}
) {

    const response =
        await fetch(
            `${GITHUB_API}${endpoint}`,
            {

                ...options,

                headers: {

                    ...githubHeaders(),

                    ...(options.headers || {})

                }

            }
        );


    const text =
        await response.text();


    let data;


    try {

        data =
            JSON.parse(text);

    }

    catch {

        data =
            text;

    }


    if (!response.ok) {

        throw new Error(
            `GitHub API ${response.status}: ${
                typeof data === "string"
                    ? data
                    : JSON.stringify(data)
            }`
        );

    }


    return data;

}


/*
=========================================================
 GITHUB PATH
=========================================================
*/

/*
IMPORTANT :

encodeURIComponent("libraryofbabel/page001.txt")

produit :

libraryofbabel%2Fpage001.txt

Ce n'est pas idéal pour les chemins GitHub.

On encode donc chaque partie séparément.
*/

function encodeGitHubPath(
    filePath
) {

    return filePath
        .split("/")
        .map(
            part =>
                encodeURIComponent(part)
        )
        .join("/");

}


/*
=========================================================
 GITHUB FILES
=========================================================
*/

async function githubGetFile(
    filePath
) {

    try {

        const encodedPath =
            encodeGitHubPath(
                filePath
            );


        return await githubRequest(
            `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodedPath}?ref=${GITHUB_BRANCH}`
        );

    }

    catch (error) {

        if (
            error.message.includes(
                "GitHub API 404"
            )
        ) {

            return null;

        }

        throw error;

    }

}


async function githubReadFile(
    filePath
) {

    const file =
        await githubGetFile(
            filePath
        );


    if (
        !file ||
        !file.content
    ) {

        return null;

    }


    return {

        sha:
            file.sha,

        content:
            Buffer.from(
                file.content,
                "base64"
            ).toString("utf8")

    };

}


async function githubWriteFile(
    filePath,
    content,
    message,
    sha = null
) {

    const body = {

        message,

        content:
            Buffer.from(
                content,
                "utf8"
            ).toString("base64"),

        branch:
            GITHUB_BRANCH

    };


    if (sha) {

        body.sha =
            sha;

    }


    const encodedPath =
        encodeGitHubPath(
            filePath
        );


    return await githubRequest(
        `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodedPath}`,
        {

            method:
                "PUT",

            headers: {

                "Content-Type":
                    "application/json"

            },

            body:
                JSON.stringify(body)

        }
    );

}


async function githubWriteBuffer(
    filePath,
    buffer,
    message,
    sha = null
) {

    const body = {

        message,

        content:
            buffer.toString("base64"),

        branch:
            GITHUB_BRANCH

    };


    if (sha) {

        body.sha =
            sha;

    }


    const encodedPath =
        encodeGitHubPath(
            filePath
        );


    return await githubRequest(
        `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodedPath}`,
        {

            method:
                "PUT",

            headers: {

                "Content-Type":
                    "application/json"

            },

            body:
                JSON.stringify(body)

        }
    );

}


async function githubDeleteFile(
    filePath,
    message
) {

    const file =
        await githubGetFile(
            filePath
        );


    if (!file) {

        return false;

    }


    const encodedPath =
        encodeGitHubPath(
            filePath
        );


    await githubRequest(
        `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodedPath}`,
        {

            method:
                "DELETE",

            headers: {

                "Content-Type":
                    "application/json"

            },

            body:
                JSON.stringify({

                    message,

                    sha:
                        file.sha,

                    branch:
                        GITHUB_BRANCH

                })

        }
    );


    return true;

}


/*
=========================================================
 CHAT LOGS
=========================================================
*/

async function getLogFiles() {

    try {

        const data =
            await githubRequest(
                `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/chat-log?ref=${GITHUB_BRANCH}`
            );


        return data

            .filter(
                file =>
                    file.type === "file" &&
                    /^chat-log\d+\.json$/i.test(
                        file.name
                    )
            )

            .sort(
                (a, b) => {

                    const A =
                        parseInt(
                            a.name.match(/\d+/)[0],
                            10
                        );

                    const B =
                        parseInt(
                            b.name.match(/\d+/)[0],
                            10
                        );

                    return A - B;

                }
            );

    }

    catch (error) {

        if (
            error.message.includes(
                "GitHub API 404"
            )
        ) {

            return [];

        }

        throw error;

    }

}


async function createLog(
    number
) {

    const filename =
        `chat-log${String(number).padStart(3, "0")}.json`;

    const filePath =
        `chat-log/${filename}`;


    const data = {

        id:
            `chat-log${String(number).padStart(3, "0")}`,

        created:
            new Date().toISOString(),

        messages: []

    };


    await githubWriteFile(
        filePath,
        JSON.stringify(
            data,
            null,
            2
        ),
        `Create ${filename}`
    );


    console.log(
        `[CHAT] Created ${filename}`
    );


    return filePath;

}


async function getCurrentLog() {

    const files =
        await getLogFiles();


    if (
        files.length === 0
    ) {

        return await createLog(1);

    }


    const last =
        files[files.length - 1];


    const current =
        await githubReadFile(
            `chat-log/${last.name}`
        );


    if (!current) {

        return await createLog(
            files.length + 1
        );

    }


    if (
        Buffer.byteLength(
            current.content,
            "utf8"
        ) >= CHAT_LOG_LIMIT
    ) {

        const next =
            parseInt(
                last.name.match(/\d+/)[0],
                10
            ) + 1;


        return await createLog(
            next
        );

    }


    return `chat-log/${last.name}`;

}


async function saveChatMessage(
    message
) {

    let filePath =
        await getCurrentLog();


    let file =
        await githubReadFile(
            filePath
        );


    if (!file) {

        await createLog(1);

        filePath =
            "chat-log/chat-log001.json";

        file =
            await githubReadFile(
                filePath
            );

    }


    let data =
        JSON.parse(
            file.content
        );


    data.messages.push(
        message
    );


    let serialized =
        JSON.stringify(
            data,
            null,
            2
        );


    if (
        Buffer.byteLength(
            serialized,
            "utf8"
        ) > CHAT_LOG_LIMIT &&
        data.messages.length > 1
    ) {

        const files =
            await getLogFiles();


        const last =
            files[files.length - 1];


        const next =
            parseInt(
                last.name.match(/\d+/)[0],
                10
            ) + 1;


        filePath =
            await createLog(
                next
            );


        file =
            await githubReadFile(
                filePath
            );


        data =
            JSON.parse(
                file.content
            );


        data.messages.push(
            message
        );


        serialized =
            JSON.stringify(
                data,
                null,
                2
            );

    }


    await githubWriteFile(
        filePath,
        serialized,
        `Add chat message to ${pathName(filePath)}`,
        file.sha
    );


    return filePath;

}


function pathName(
    filePath
) {

    return filePath
        .split("/")
        .pop();

}


/*
=========================================================
 PASSWORD
=========================================================
*/

function hashPassword(
    password
) {

    return new Promise(
        (
            resolve,
            reject
        ) => {

            const salt =
                crypto
                    .randomBytes(16)
                    .toString("hex");


            crypto.scrypt(
                password,
                salt,
                64,
                {
                    N: 16384,
                    r: 8,
                    p: 1
                },
                (
                    error,
                    derivedKey
                ) => {

                    if (error) {

                        reject(error);

                        return;

                    }


                    resolve(
                        `scrypt:${salt}:${derivedKey.toString("hex")}`
                    );

                }
            );

        }
    );

}


function verifyPassword(
    password,
    stored
) {

    return new Promise(
        (
            resolve,
            reject
        ) => {

            const parts =
                String(stored || "")
                    .split(":");


            if (
                parts.length !== 3 ||
                parts[0] !== "scrypt"
            ) {

                resolve(false);

                return;

            }


            const salt =
                parts[1];

            const original =
                Buffer.from(
                    parts[2],
                    "hex"
                );


            crypto.scrypt(
                password,
                salt,
                original.length,
                {
                    N: 16384,
                    r: 8,
                    p: 1
                },
                (
                    error,
                    derived
                ) => {

                    if (error) {

                        reject(error);

                        return;

                    }


                    resolve(
                        crypto.timingSafeEqual(
                            original,
                            derived
                        )
                    );

                }
            );

        }
    );

}


/*
=========================================================
 SESSIONS
=========================================================
*/

const sessions =
    new Map();


const SESSION_DURATION =
    1000 *
    60 *
    60 *
    24 *
    7;


function createSession(
    user
) {

    const token =
        crypto
            .randomBytes(32)
            .toString("hex");


    sessions.set(
        token,
        {

            userId:
                user.id,

            username:
                user.username,

            profilePicture:
                user.profile_picture || null,

            expires:
                Date.now() +
                SESSION_DURATION

        }
    );


    return token;

}


function getSession(
    request
) {

    const header =
        request.headers.authorization;


    if (
        !header ||
        !header.startsWith("Bearer ")
    ) {

        return null;

    }


    const token =
        header.slice(7);


    return getSessionFromToken(
        token
    );

}


function getSessionFromToken(
    token
) {

    if (!token) {

        return null;

    }


    const session =
        sessions.get(
            token
        );


    if (!session) {

        return null;

    }


    if (
        session.expires <
        Date.now()
    ) {

        sessions.delete(
            token
        );

        return null;

    }


    return {

        token,

        ...session

    };

}


function requireSession(
    request,
    response
) {

    const session =
        getSession(
            request
        );


    if (!session) {

        sendJSON(
            response,
            401,
            {
                error:
                    "NOT_AUTHENTICATED"
            }
        );

        return null;

    }


    return session;

}


/*
=========================================================
 VALIDATION
=========================================================
*/

function cleanUsername(
    username
) {

    return String(
        username || ""
    )
        .trim()
        .replace(
            /\s+/g,
            "_"
        )
        .slice(
            0,
            USERNAME_MAX
        );

}


function validUsername(
    username
) {

    return (
        username.length >= USERNAME_MIN &&
        username.length <= USERNAME_MAX &&
        /^[a-zA-Z0-9_-]+$/.test(username)
    );

}


function validPassword(
    password
) {

    return (
        typeof password === "string" &&
        password.length >= 8 &&
        password.length <= 128
    );

}


function validProfileURL(
    value
) {

    if (
        value === null ||
        value === undefined ||
        value === ""
    ) {

        return true;

    }


    try {

        const url =
            new URL(value);


        return (
            url.protocol === "https:" ||
            url.protocol === "http:"
        );

    }

    catch {

        return false;

    }

}


/*
=========================================================
 HTTP JSON
=========================================================
*/

function sendJSON(
    response,
    status,
    data
) {

    response.writeHead(
        status,
        {

            "Content-Type":
                "application/json; charset=utf-8",

            "Access-Control-Allow-Origin":
                "*",

            "Access-Control-Allow-Headers":
                "Content-Type, Authorization",

            "Access-Control-Allow-Methods":
                "GET,POST,DELETE,OPTIONS"

        }
    );


    response.end(
        JSON.stringify(
            data
        )
    );

}


async function readJSON(
    request
) {

    return new Promise(
        (
            resolve,
            reject
        ) => {

            let body =
                "";


            request.on(
                "data",
                chunk => {

                    body +=
                        chunk.toString();


                    if (
                        body.length >
                        1024 * 1024
                    ) {

                        reject(
                            new Error(
                                "Request too large"
                            )
                        );

                        request.destroy();

                    }

                }
            );


            request.on(
                "end",
                () => {

                    try {

                        resolve(
                            JSON.parse(
                                body || "{}"
                            )
                        );

                    }

                    catch {

                        reject(
                            new Error(
                                "Invalid JSON"
                            )
                        );

                    }

                }
            );


            request.on(
                "error",
                reject
            );

        }
    );

}


/*
=========================================================
 REGISTER
=========================================================
*/

async function register(
    request,
    response
) {

    try {

        const data =
            await readJSON(
                request
            );


        const username =
            cleanUsername(
                data.username
            );

        const password =
            data.password;

        const profilePicture =
            data.profile_picture ||
            null;


        if (
            !validUsername(
                username
            )
        ) {

            sendJSON(
                response,
                400,
                {
                    error:
                        "INVALID_USERNAME"
                }
            );

            return;

        }


        if (
            !validPassword(
                password
            )
        ) {

            sendJSON(
                response,
                400,
                {
                    error:
                        "INVALID_PASSWORD"
                }
            );

            return;

        }


        if (
            !validProfileURL(
                profilePicture
            )
        ) {

            sendJSON(
                response,
                400,
                {
                    error:
                        "INVALID_PROFILE_PICTURE_URL"
                }
            );

            return;

        }


        const existing =
            await supabase
                .from("users")
                .select("id")
                .ilike(
                    "username",
                    username
                )
                .maybeSingle();


        if (existing.error) {

            throw existing.error;

        }


        if (existing.data) {

            sendJSON(
                response,
                409,
                {
                    error:
                        "USERNAME_ALREADY_USED"
                }
            );

            return;

        }


        const passwordHash =
            await hashPassword(
                password
            );


        const inserted =
            await supabase
                .from("users")
                .insert({

                    username,

                    password_hash:
                        passwordHash,

                    profile_picture:
                        profilePicture

                })
                .select(
                    "id, username, profile_picture, created_at"
                )
                .single();


        if (inserted.error) {

            throw inserted.error;

        }


        const token =
            createSession(
                inserted.data
            );


        sendJSON(
            response,
            201,
            {

                success:
                    true,

                token,

                user:
                    inserted.data

            }
        );

    }

    catch (error) {

        console.error(
            "[REGISTER]",
            error
        );


        sendJSON(
            response,
            500,
            {
                error:
                    "REGISTER_FAILED"
            }
        );

    }

}


/*
=========================================================
 LOGIN
=========================================================
*/

async function login(
    request,
    response
) {

    try {

        const data =
            await readJSON(
                request
            );


        const username =
            cleanUsername(
                data.username
            );

        const password =
            data.password;


        const result =
            await supabase
                .from("users")
                .select(
                    "id, username, password_hash, profile_picture, created_at"
                )
                .ilike(
                    "username",
                    username
                )
                .maybeSingle();


        if (result.error) {

            throw result.error;

        }


        if (!result.data) {

            sendJSON(
                response,
                401,
                {
                    error:
                        "INVALID_LOGIN"
                }
            );

            return;

        }


        const valid =
            await verifyPassword(
                password,
                result.data.password_hash
            );


        if (!valid) {

            sendJSON(
                response,
                401,
                {
                    error:
                        "INVALID_LOGIN"
                }
            );

            return;

        }


        const token =
            createSession(
                result.data
            );


        sendJSON(
            response,
            200,
            {

                success:
                    true,

                token,

                user: {

                    id:
                        result.data.id,

                    username:
                        result.data.username,

                    profile_picture:
                        result.data.profile_picture,

                    created_at:
                        result.data.created_at

                }

            }
        );

    }

    catch (error) {

        console.error(
            "[LOGIN]",
            error
        );


        sendJSON(
            response,
            500,
            {
                error:
                    "LOGIN_FAILED"
            }
        );

    }

}


/*
=========================================================
 LOGOUT
=========================================================
*/

async function logout(
    request,
    response
) {

    const session =
        getSession(
            request
        );


    if (session) {

        sessions.delete(
            session.token
        );

    }


    sendJSON(
        response,
        200,
        {
            success:
                true
        }
    );

}


/*
=========================================================
 ME
=========================================================
*/

async function me(
    request,
    response
) {

    const session =
        requireSession(
            request,
            response
        );


    if (!session) {

        return;

    }


    const result =
        await supabase
            .from("users")
            .select(
                "id, username, profile_picture, created_at"
            )
            .eq(
                "id",
                session.userId
            )
            .single();


    if (result.error) {

        sendJSON(
            response,
            500,
            {
                error:
                    "USER_LOOKUP_FAILED"
            }
        );

        return;

    }


    session.username =
        result.data.username;

    session.profilePicture =
        result.data.profile_picture ||
        null;


    sendJSON(
        response,
        200,
        {

            authenticated:
                true,

            user:
                result.data

        }
    );

}


/*
=========================================================
 CHAT LOG API
=========================================================
*/

async function listLogs(
    request,
    response
) {

    try {

        const files =
            await getLogFiles();


        const logs =
            files.map(
                file => ({

                    name:
                        file.name,

                    path:
                        `chat-log/${file.name}`,

                    size:
                        file.size,

                    sha:
                        file.sha,

                    url:
                        file.html_url

                })
            );


        sendJSON(
            response,
            200,
            {
                logs
            }
        );

    }

    catch (error) {

        console.error(
            "[LOG LIST]",
            error
        );


        sendJSON(
            response,
            500,
            {
                error:
                    "LOG_LIST_FAILED"
            }
        );

    }

}


async function getLog(
    request,
    response,
    number
) {

    try {

        const parsed =
            parseInt(
                number,
                10
            );


        if (
            !Number.isFinite(parsed) ||
            parsed < 1
        ) {

            sendJSON(
                response,
                400,
                {
                    error:
                        "INVALID_LOG_NUMBER"
                }
            );

            return;

        }


        const normalized =
            String(parsed)
                .padStart(3, "0");


        const filePath =
            `chat-log/chat-log${normalized}.json`;


        const file =
            await githubReadFile(
                filePath
            );


        if (!file) {

            sendJSON(
                response,
                404,
                {
                    error:
                        "LOG_NOT_FOUND"
                }
            );

            return;

        }


        sendJSON(
            response,
            200,
            JSON.parse(
                file.content
            )
        );

    }

    catch (error) {

        console.error(
            "[LOG]",
            error
        );


        sendJSON(
            response,
            500,
            {
                error:
                    "LOG_READ_FAILED"
            }
        );

    }

}


/*
=========================================================
 GENERIC GITHUB DIRECTORY
=========================================================
*/

async function listDirectory(
    directory
) {

    try {

        const data =
            await githubRequest(
                `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodeGitHubPath(directory)}?ref=${GITHUB_BRANCH}`
            );


        return data
            .filter(
                file =>
                    file.type === "file"
            )
            .map(
                file => ({

                    name:
                        file.name,

                    path:
                        file.path,

                    size:
                        file.size,

                    url:
                        file.download_url,

                    github:
                        file.html_url

                })
            );

    }

    catch (error) {

        if (
            error.message.includes(
                "GitHub API 404"
            )
        ) {

            return [];

        }

        throw error;

    }

}


/*
=========================================================
 MEDIA
=========================================================
*/

async function listMedia(
    request,
    response
) {

    try {

        const pictures =
            await listDirectory(
                "picture"
            );


        const music =
            await listDirectory(
                "media/music"
            );


        const videos =
            await listDirectory(
                "media/video"
            );


        sendJSON(
            response,
            200,
            {

                picture:
                    pictures,

                music:
                    music,

                video:
                    videos

            }
        );

    }

    catch (error) {

        console.error(
            "[MEDIA]",
            error
        );


        sendJSON(
            response,
            500,
            {
                error:
                    "MEDIA_LIST_FAILED"
            }
        );

    }

}

/*
=========================================================
 LIBRARY OF BABEL — DREAMCORE
=========================================================
*/

const LIBRARY_PATH =
    "libraryofbabel";

const LIBRARY_PAGE_PREFIX =
    "page";

const LIBRARY_PAGE_EXTENSION =
    ".txt";


/*
=========================================================
 GITHUB PATH ENCODER
=========================================================
*/

function encodeGitHubPath(filePath) {

    return filePath
        .split("/")
        .map(
            part => encodeURIComponent(part)
        )
        .join("/");

}


/*
=========================================================
 LIBRARY — GET PAGE
=========================================================
*/

async function getLibraryPage(
    request,
    response,
    pageNumber
) {

    try {

        const page =
            parseInt(
                pageNumber,
                10
            );


        /*
        Vérification du numéro
        */

        if (
            !Number.isInteger(page) ||
            page < 1
        ) {

            sendJSON(
                response,
                400,
                {
                    error:
                        "INVALID_PAGE",

                    page:
                        pageNumber
                }
            );

            return;

        }


        /*
        page001.txt
        page002.txt
        page003.txt
        etc.
        */

        const filename =
            `${LIBRARY_PAGE_PREFIX}${String(page).padStart(3, "0")}${LIBRARY_PAGE_EXTENSION}`;


        const filePath =
            `${LIBRARY_PATH}/${filename}`;


        console.log(
            `[LIBRARY] Reading ${filePath}`
        );


        /*
        Lecture GitHub
        */

        const file =
            await githubReadFile(
                filePath
            );


        /*
        Page inexistante
        */

        if (!file) {

            console.log(
                `[LIBRARY] Page not found: ${filePath}`
            );


            sendJSON(
                response,
                404,
                {

                    error:
                        "PAGE_NOT_FOUND",

                    page,

                    filename,

                    path:
                        filePath

                }
            );


            return;

        }


        /*
        Réponse
        */

        sendJSON(
            response,
            200,
            {

                success:
                    true,

                page,

                filename,

                path:
                    filePath,

                content:
                    file.content,

                sha:
                    file.sha

            }
        );

    }

    catch (error) {

        console.error(
            "[LIBRARY]",
            error
        );


        sendJSON(
            response,
            500,
            {

                error:
                    "LIBRARY_READ_FAILED",

                message:
                    error.message

            }
        );

    }

}


/*
=========================================================
 LIBRARY — LIST PAGES
=========================================================
*/

async function listLibraryPages(
    request,
    response
) {

    try {

        const directory =
            await githubRequest(
                `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodeGitHubPath(LIBRARY_PATH)}?ref=${GITHUB_BRANCH}`
            );


        if (
            !Array.isArray(directory)
        ) {

            sendJSON(
                response,
                500,
                {

                    error:
                        "INVALID_LIBRARY_DIRECTORY"

                }
            );

            return;

        }


        const pages =
            directory

                .filter(
                    file =>
                        file.type === "file" &&
                        /^page\d+\.txt$/i.test(
                            file.name
                        )
                )

                .map(
                    file => {

                        const match =
                            file.name.match(
                                /^page(\d+)\.txt$/i
                            );


                        return {

                            page:
                                parseInt(
                                    match[1],
                                    10
                                ),

                            filename:
                                file.name,

                            path:
                                file.path,

                            size:
                                file.size,

                            url:
                                file.download_url

                        };

                    }
                )

                .sort(
                    (
                        a,
                        b
                    ) =>
                        a.page -
                        b.page
                );


        sendJSON(
            response,
            200,
            {

                success:
                    true,

                count:
                    pages.length,

                pages

            }
        );

    }

    catch (error) {

        console.error(
            "[LIBRARY LIST]",
            error
        );


        if (
            error.message.includes(
                "GitHub API 404"
            )
        ) {

            sendJSON(
                response,
                404,
                {

                    error:
                        "LIBRARY_NOT_FOUND",

                    path:
                        LIBRARY_PATH

                }
            );

            return;

        }


        sendJSON(
            response,
            500,
            {

                error:
                    "LIBRARY_LIST_FAILED"

            }
        );

    }

}
/*
=========================================================
 LIBRARY OF BABEL — DREAMCORE
=========================================================
*/

/*
Structure GitHub attendue :

dreamcore/
└── libraryofbabel/
    ├── page001.txt
    ├── page002.txt
    ├── page003.txt
    └── ...
*/


async function listLibraryPages() {

    console.log(
        "[LIBRARY] Reading GitHub directory: libraryofbabel"
    );


    try {

        const data =
            await githubRequest(
                `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/libraryofbabel?ref=${GITHUB_BRANCH}`
            );


        if (!Array.isArray(data)) {

            console.error(
                "[LIBRARY] GitHub returned something other than a directory"
            );

            return [];

        }


        const pages =
            data

                .filter(
                    file =>
                        file.type === "file" &&
                        /^page\d+\.txt$/i.test(
                            file.name
                        )
                )

                .map(
                    file => {

                        const match =
                            file.name.match(
                                /^page(\d+)\.txt$/i
                            );


                        return {

                            name:
                                file.name,

                            page:
                                parseInt(
                                    match[1],
                                    10
                                ),

                            path:
                                file.path,

                            size:
                                file.size,

                            url:
                                file.download_url,

                            github:
                                file.html_url

                        };

                    }
                )

                .sort(
                    (a, b) =>
                        a.page - b.page
                );


        console.log(
            `[LIBRARY] ${pages.length} page(s) found`
        );


        return pages;

    }

    catch (error) {

        if (
            error.message.includes(
                "GitHub API 404"
            )
        ) {

            console.error(
                "[LIBRARY] Directory not found: libraryofbabel"
            );

            return [];

        }


        throw error;

    }

}


async function getLibraryPage(
    pageNumber
) {

    const parsed =
        parseInt(
            pageNumber,
            10
        );


    if (
        !Number.isFinite(parsed) ||
        parsed < 1
    ) {

        return null;

    }


    const filename =
        `page${String(parsed).padStart(3, "0")}.txt`;


    const filePath =
        `libraryofbabel/${filename}`;


    console.log(
        `[LIBRARY] Reading ${filePath}`
    );


    const file =
        await githubReadFile(
            filePath
        );


    if (!file) {

        console.log(
            `[LIBRARY] Page not found: ${filePath}`
        );

        return null;

    }


    return {

        page:
            parsed,

        name:
            filename,

        path:
            filePath,

        size:
            Buffer.byteLength(
                file.content,
                "utf8"
            ),

        content:
            file.content

    };

}


async function libraryOfBabel(
    request,
    response
) {

    try {

        const pages =
            await listLibraryPages();


        sendJSON(
            response,
            200,
            {

                success:
                    true,

                directory:
                    "libraryofbabel",

                count:
                    pages.length,

                pages

            }
        );

    }

    catch (error) {

        console.error(
            "[LIBRARY OF BABEL]",
            error
        );


        sendJSON(
            response,
            500,
            {

                error:
                    "LIBRARY_OF_BABEL_FAILED",

                message:
                    error.message

            }
        );

    }

}


async function libraryOfBabelPage(
    request,
    response,
    pageNumber
) {

    try {

        const page =
            await getLibraryPage(
                pageNumber
            );


        if (!page) {

            sendJSON(
                response,
                404,
                {

                    error:
                        "PAGE_NOT_FOUND",

                    page:
                        Number(pageNumber)

                }
            );

            return;

        }


        sendJSON(
            response,
            200,
            {

                success:
                    true,

                ...page

            }
        );

    }

    catch (error) {

        console.error(
            "[LIBRARY PAGE]",
            error
        );


        sendJSON(
            response,
            500,
            {

                error:
                    "LIBRARY_PAGE_FAILED",

                message:
                    error.message

            }
        );

    }

}

/*
=========================================================
 LIBRARY OF BABEL
=========================================================
*/

/*
GET /api/libraryofbabel
*/

if (
    url.pathname ===
        "/api/libraryofbabel" &&
    request.method ===
        "GET"
) {

    await listLibraryPages(
        request,
        response
    );

    return;

}


/*
GET /api/libraryofbabel/page/1
*/

if (
    url.pathname.startsWith(
        "/api/libraryofbabel/page/"
    ) &&
    request.method ===
        "GET"
) {

    const pageNumber =
        url.pathname
            .split("/")
            .pop();


    await getLibraryPage(
        request,
        response,
        pageNumber
    );

    return;

}

/*
=========================================================
 UPLOAD
=========================================================
*/

const IMAGE_EXTENSIONS = [

    ".jpg",
    ".jpeg",
    ".png",
    ".gif",
    ".webp",
    ".bmp"

];


const MUSIC_EXTENSIONS = [

    ".mp3",
    ".wav",
    ".ogg",
    ".flac",
    ".m4a",
    ".aac"

];


const VIDEO_EXTENSIONS = [

    ".mp4",
    ".webm",
    ".mov",
    ".mkv",
    ".avi"

];


function cleanFilename(
    filename
) {

    return String(filename)
        .replace(
            /[^a-zA-Z0-9._-]/g,
            "_"
        );

}


function uploadType(
    extension
) {

    const ext =
        extension.toLowerCase();


    if (
        IMAGE_EXTENSIONS.includes(
            ext
        )
    ) {

        return "picture";

    }


    if (
        MUSIC_EXTENSIONS.includes(
            ext
        )
    ) {

        return "music";

    }


    if (
        VIDEO_EXTENSIONS.includes(
            ext
        )
    ) {

        return "video";

    }


    return null;

}


async function getNextMediaNumber(
    directory,
    prefix
) {

    const files =
        await listDirectory(
            directory
        );


    let highest =
        0;


    for (
        const file of files
    ) {

        const match =
            file.name.match(
                new RegExp(
                    `^${prefix}(\\d+)\\.`,
                    "i"
                )
            );


        if (match) {

            highest =
                Math.max(
                    highest,
                    parseInt(
                        match[1],
                        10
                    )
                );

        }

    }


    return highest + 1;

}


async function upload(
    request,
    response
) {

    const session =
        requireSession(
            request,
            response
        );


    if (!session) {

        return;

    }


    let busboy;


    try {

        busboy =
            Busboy({

                headers:
                    request.headers,

                limits: {

                    fileSize:
                        UPLOAD_LIMIT,

                    files:
                        1

                }

            });

    }

    catch {

        sendJSON(
            response,
            400,
            {
                error:
                    "INVALID_UPLOAD"
            }
        );

        return;

    }


    let fileBuffer =
        Buffer.alloc(0);

    let extension =
        "";

    let originalName =
        "";

    let uploadError =
        null;


    busboy.on(
        "file",
        (
            field,
            file,
            info
        ) => {

            originalName =
                cleanFilename(
                    info.filename
                );


            extension =
                path.extname(
                    originalName
                ).toLowerCase();


            const chunks =
                [];


            file.on(
                "data",
                chunk => {

                    chunks.push(
                        chunk
                    );

                }
            );


            file.on(
                "limit",
                () => {

                    uploadError =
                        "FILE_TOO_LARGE";

                }
            );


            file.on(
                "end",
                () => {

                    fileBuffer =
                        Buffer.concat(
                            chunks
                        );

                }
            );

        }
    );


    busboy.on(
        "finish",
        async () => {

            try {

                if (uploadError) {

                    sendJSON(
                        response,
                        400,
                        {
                            error:
                                uploadError
                        }
                    );

                    return;

                }


                if (!fileBuffer.length) {

                    sendJSON(
                        response,
                        400,
                        {
                            error:
                                "NO_FILE"
                        }
                    );

                    return;

                }


                const type =
                    uploadType(
                        extension
                    );


                if (!type) {

                    sendJSON(
                        response,
                        400,
                        {
                            error:
                                "FILE_TYPE_NOT_ALLOWED"
                        }
                    );

                    return;

                }


                let directory;
                let prefix;


                if (
                    type === "picture"
                ) {

                    directory =
                        "picture";

                    prefix =
                        "picture";

                }

                else if (
                    type === "music"
                ) {

                    directory =
                        "media/music";

                    prefix =
                        "music";

                }

                else {

                    directory =
                        "media/video";

                    prefix =
                        "video";

                }


                const number =
                    await getNextMediaNumber(
                        directory,
                        prefix
                    );


                const filename =
                    `${prefix}${String(number).padStart(3, "0")}${extension}`;


                const filePath =
                    `${directory}/${filename}`;


                await githubWriteBuffer(
                    filePath,
                    fileBuffer,
                    `Upload ${filename}`
                );


                sendJSON(
                    response,
                    201,
                    {

                        success:
                            true,

                        type,

                        filename,

                        originalName,

                        size:
                            fileBuffer.length,

                        path:
                            filePath

                    }
                );

            }

            catch (error) {

                console.error(
                    "[UPLOAD]",
                    error
                );


                sendJSON(
                    response,
                    500,
                    {
                        error:
                            "UPLOAD_FAILED"
                    }
                );

            }

        }
    );


    request.pipe(
        busboy
    );

}


/*
=========================================================
 DELETE MEDIA
=========================================================
*/

async function deleteMedia(
    request,
    response
) {

    const session =
        requireSession(
            request,
            response
        );


    if (!session) {

        return;

    }


    const url =
        new URL(
            request.url,
            `http://${request.headers.host}`
        );


    const filePath =
        url.searchParams.get(
            "path"
        );


    if (!filePath) {

        sendJSON(
            response,
            400,
            {
                error:
                    "PATH_REQUIRED"
            }
        );

        return;

    }


    const allowed =
        filePath.startsWith(
            "picture/"
        ) ||
        filePath.startsWith(
            "media/music/"
        ) ||
        filePath.startsWith(
            "media/video/"
        );


    if (!allowed) {

        sendJSON(
            response,
            403,
            {
                error:
                    "PATH_NOT_ALLOWED"
            }
        );

        return;

    }


    try {

        await githubDeleteFile(
            filePath,
            `Delete ${filePath}`
        );


        sendJSON(
            response,
            200,
            {
                success:
                    true
            }
        );

    }

    catch (error) {

        console.error(
            "[DELETE]",
            error
        );


        sendJSON(
            response,
            500,
            {
                error:
                    "DELETE_FAILED"
            }
        );

    }

}


/*
=========================================================
 WEBSOCKET
=========================================================
*/

const users =
    new Map();


function generateGuestName() {

    return (
        "USER_" +
        Math.floor(
            Math.random() *
            10000
        )
        .toString()
        .padStart(
            4,
            "0"
        )
    );

}


function broadcast(
    data,
    except = null
) {

    const serialized =
        JSON.stringify(
            data
        );


    for (
        const client of wss.clients
    ) {

        if (
            client === except
        ) {

            continue;

        }


        if (
            client.readyState ===
            WebSocket.OPEN
        ) {

            client.send(
                serialized
            );

        }

    }

}


function sendWS(
    ws,
    data
) {

    if (
        ws.readyState ===
        WebSocket.OPEN
    ) {

        ws.send(
            JSON.stringify(
                data
            )
        );

    }

}


/*
=========================================================
 HTTP SERVER
=========================================================
*/

const server =
    http.createServer(
        handleRequest
    );


const wss =
    new WebSocket.Server({

        noServer:
            true

    });


/*
=========================================================
 WEBSOCKET UPGRADE
=========================================================
*/

server.on(
    "upgrade",
    (
        request,
        socket,
        head
    ) => {

        const url =
            new URL(
                request.url,
                `http://${request.headers.host}`
            );


        if (
            url.pathname !==
            "/ws"
        ) {

            socket.destroy();

            return;

        }


        wss.handleUpgrade(
            request,
            socket,
            head,
            ws => {

                wss.emit(
                    "connection",
                    ws,
                    request
                );

            }
        );

    }
);


/*
=========================================================
 WEBSOCKET CONNECTION
=========================================================
*/

wss.on(
    "connection",
    (
        ws,
        request
    ) => {

        const url =
            new URL(
                request.url,
                `http://${request.headers.host}`
            );


        const token =
            url.searchParams.get(
                "token"
            );


        let session =
            null;


        if (token) {

            session =
                getSessionFromToken(
                    token
                );

        }


        const user = {

            ws,

            username:
                session
                    ? session.username
                    : generateGuestName(),

            userId:
                session
                    ? session.userId
                    : null,

            profilePicture:
                session
                    ? session.profilePicture
                    : null,

            authenticated:
                Boolean(
                    session
                )

        };


        users.set(
            ws,
            user
        );


        console.log(
            "[WS CONNECT]",
            user.authenticated
                ? `${user.username} [AUTHENTICATED]`
                : `${user.username} [GUEST]`
        );


        sendWS(
            ws,
            {

                type:
                    "welcome",

                username:
                    user.username,

                user_id:
                    user.userId,

                profile_picture:
                    user.profilePicture,

                authenticated:
                    user.authenticated

            }
        );


        broadcast(
            {

                type:
                    "users",

                count:
                    users.size

            }
        );


        ws.on(
            "message",
            async raw => {

                try {

                    const data =
                        JSON.parse(
                            raw.toString()
                        );


                    if (
                        data.type ===
                        "message"
                    ) {

                        const message =
                            String(
                                data.message ||
                                ""
                            )
                            .trim()
                            .slice(
                                0,
                                MESSAGE_LIMIT
                            );


                        if (!message) {

                            return;

                        }


                        const chatMessage = {

                            id:
                                crypto
                                    .randomBytes(8)
                                    .toString("hex"),

                            username:
                                user.username,

                            user_id:
                                user.userId,

                            profile_picture:
                                user.profilePicture,

                            message,

                            timestamp:
                                new Date()
                                    .toISOString()

                        };


                        await saveChatMessage(
                            chatMessage
                        );


                        broadcast(
                            {

                                type:
                                    "message",

                                data:
                                    chatMessage

                            }
                        );

                    }


                    if (
                        data.type ===
                        "ping"
                    ) {

                        sendWS(
                            ws,
                            {

                                type:
                                    "pong"

                            }
                        );

                    }

                }

                catch (error) {

                    console.error(
                        "[WS MESSAGE]",
                        error
                    );


                    sendWS(
                        ws,
                        {

                            type:
                                "error",

                            message:
                                "SERVER_ERROR"

                        }
                    );

                }

            }
        );


        ws.on(
            "close",
            () => {

                users.delete(
                    ws
                );


                console.log(
                    "[WS DISCONNECT]",
                    user.username
                );


                broadcast(
                    {

                        type:
                            "users",

                        count:
                            users.size

                    }
                );

            }
        );

    }
);


/*
=========================================================
 HTTP ROUTES
=========================================================
*/

async function handleRequest(
    request,
    response
) {

    const url =
        new URL(
            request.url,
            `http://${request.headers.host}`
        );


    /*
    =====================================================
    CORS
    =====================================================
    */

    if (
        request.method ===
        "OPTIONS"
    ) {

        response.writeHead(
            204,
            {

                "Access-Control-Allow-Origin":
                    "*",

                "Access-Control-Allow-Methods":
                    "GET,POST,DELETE,OPTIONS",

                "Access-Control-Allow-Headers":
                    "Content-Type, Authorization"

            }
        );


        response.end();

        return;

    }


    /*
    =====================================================
    HEALTH
    =====================================================
    */

    if (
        url.pathname ===
        "/health"
    ) {

        sendJSON(
            response,
            200,
            {

                status:
                    "online",

                server:
                    "dreamcore",

                users:
                    users.size,

                uptime:
                    process.uptime(),

                time:
                    new Date()
                        .toISOString()

            }
        );

        return;

    }


    /*
    =====================================================
    REGISTER
    =====================================================
    */

    if (
        url.pathname ===
            "/api/register" &&
        request.method ===
            "POST"
    ) {

        await register(
            request,
            response
        );

        return;

    }


    /*
    =====================================================
    LOGIN
    =====================================================
    */

    if (
        url.pathname ===
            "/api/login" &&
        request.method ===
            "POST"
    ) {

        await login(
            request,
            response
        );

        return;

    }


    /*
    =====================================================
    LOGOUT
    =====================================================
    */

    if (
        url.pathname ===
            "/api/logout" &&
        request.method ===
            "POST"
    ) {

        await logout(
            request,
            response
        );

        return;

    }


    /*
    =====================================================
    ME
    =====================================================
    */

    if (
        url.pathname ===
            "/api/me" &&
        request.method ===
            "GET"
    ) {

        await me(
            request,
            response
        );

        return;

    }


    /*
    =====================================================
    CHAT LOGS
    =====================================================
    */

    if (
        url.pathname ===
            "/api/chat/logs" &&
        request.method ===
            "GET"
    ) {

        await listLogs(
            request,
            response
        );

        return;

    }


    if (
        url.pathname.startsWith(
            "/api/chat/log/"
        ) &&
        request.method ===
            "GET"
    ) {

        const number =
            url.pathname
                .split("/")
                .pop();


        await getLog(
            request,
            response,
            number
        );

        return;

    }


    /*
    =====================================================
    MEDIA
    =====================================================
    */

    if (
        url.pathname ===
            "/api/media" &&
        request.method ===
            "GET"
    ) {

        await listMedia(
            request,
            response
        );

        return;

    }


    /*
    =====================================================
    LIBRARY OF BABEL
    =====================================================
    */

    if (
        url.pathname ===
            "/api/libraryofbabel" &&
        request.method ===
            "GET"
    ) {

        await libraryOfBabel(
            request,
            response
        );

        return;

    }


    /*
    =====================================================
    LIBRARY OF BABEL PAGE
    =====================================================
    */

    if (
        url.pathname.startsWith(
            "/api/libraryofbabel/page/"
        ) &&
        request.method ===
            "GET"
    ) {

        const pageNumber =
            url.pathname
                .split("/")
                .pop();


        await libraryOfBabelPage(
            request,
            response,
            pageNumber
        );

        return;

    }


    /*
    =====================================================
    UPLOAD
    =====================================================
    */

    if (
        url.pathname ===
            "/api/upload" &&
        request.method ===
            "POST"
    ) {

        await upload(
            request,
            response
        );

        return;

    }


    /*
    =====================================================
    DELETE MEDIA
    =====================================================
    */

    if (
        url.pathname ===
            "/api/media" &&
        request.method ===
            "DELETE"
    ) {

        await deleteMedia(
            request,
            response
        );

        return;

    }


    /*
    =====================================================
    CHAT STATUS
    =====================================================
    */

    if (
        url.pathname ===
        "/api/chat/status"
    ) {

        sendJSON(
            response,
            200,
            {

                online:
                    true,

                users:
                    users.size,

                websocket:
                    "/ws"

            }
        );

        return;

    }


    /*
    =====================================================
    404
    =====================================================
    */

    sendJSON(
        response,
        404,
        {

            error:
                "NOT_FOUND"

        }
    );

}


/*
=========================================================
 CLEAN EXPIRED SESSIONS
=========================================================
*/

setInterval(
    () => {

        const now =
            Date.now();


        for (
            const [
                token,
                session
            ] of sessions
        ) {

            if (
                session.expires <
                now
            ) {

                sessions.delete(
                    token
                );

            }

        }

    },
    60 * 60 * 1000
);


/*
=========================================================
 START
=========================================================
*/

server.listen(
    PORT,
    "0.0.0.0",
    () => {

        console.log(
            "========================================"
        );

        console.log(
            " DREAMCORE SERVER V4"
        );

        console.log(
            "========================================"
        );

        console.log(
            `PORT : ${PORT}`
        );

        console.log(
            "WEBSOCKET : /ws"
        );

        console.log(
            `GITHUB : ${GITHUB_OWNER}/${GITHUB_REPO}`
        );

        console.log(
            "LIBRARY : /api/libraryofbabel"
        );

        console.log(
            "LIBRARY PAGE : /api/libraryofbabel/page/:number"
        );

        console.log(
            "SUPABASE : CONNECTED"
        );

        console.log(
            "WEBSOCKET AUTH : TOKEN QUERY"
        );

        console.log(
            "========================================"
        );

    }
);


/*
=========================================================
 SHUTDOWN
=========================================================
*/

function shutdown() {

    console.log(
        "[DREAMCORE] Shutdown"
    );


    for (
        const client of wss.clients
    ) {

        client.close();

    }


    server.close(
        () => {

            process.exit(0);

        }
    );

}


process.on(
    "SIGTERM",
    shutdown
);


process.on(
    "SIGINT",
    shutdown
);
