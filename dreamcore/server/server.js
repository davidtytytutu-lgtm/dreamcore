/*
=========================================================
 DREAMCORE SERVER
 WebSocket + Chat + Logs + Uploads
=========================================================
*/

"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const Busboy = require("busboy");
const WebSocket = require("ws");


/*
=========================================================
 CONFIGURATION
=========================================================
*/

const PORT = process.env.PORT || 10000;

const ROOT_DIR = path.resolve(__dirname, "..");

const CHAT_LOG_DIR =
    path.join(ROOT_DIR, "chat-log");

const PICTURE_DIR =
    path.join(ROOT_DIR, "picture");

const MUSIC_DIR =
    path.join(ROOT_DIR, "media", "music");

const VIDEO_DIR =
    path.join(ROOT_DIR, "media", "video");


/*
 Limite d'un fichier de chat :

 15 Mo
*/

const CHAT_LOG_LIMIT =
    15 * 1024 * 1024;


/*
 Limite d'un upload :

 25 Mo
*/

const UPLOAD_LIMIT =
    25 * 1024 * 1024;


/*
 Limite message chat
*/

const MESSAGE_LIMIT = 500;


/*
 Extensions autorisées
*/

const IMAGE_EXTENSIONS = [
    ".jpg",
    ".jpeg",
    ".png",
    ".gif",
    ".webp",
    ".bmp",
    ".svg"
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


/*
=========================================================
 CREATION DES DOSSIERS
=========================================================
*/

function ensureDirectory(directory) {

    if (!fs.existsSync(directory)) {

        fs.mkdirSync(
            directory,
            {
                recursive: true
            }
        );

    }

}


ensureDirectory(CHAT_LOG_DIR);
ensureDirectory(PICTURE_DIR);
ensureDirectory(MUSIC_DIR);
ensureDirectory(VIDEO_DIR);


/*
=========================================================
 OUTILS
=========================================================
*/

function generateUsername() {

    const number =
        Math.floor(
            Math.random() * 10000
        )
        .toString()
        .padStart(4, "0");

    return `USER_${number}`;

}


function getTimestamp() {

    return new Date().toISOString();

}


function sanitizeText(text) {

    return String(text)
        .replace(/\0/g, "")
        .trim()
        .slice(0, MESSAGE_LIMIT);

}


function sanitizeFilename(filename) {

    return path
        .basename(filename)
        .replace(
            /[^a-zA-Z0-9._-]/g,
            "_"
        );

}


/*
=========================================================
 CHAT LOG
=========================================================
*/

function getLogFiles() {

    return fs.readdirSync(
        CHAT_LOG_DIR
    )

    .filter(
        file =>
            /^chat-log\d+\.json$/i.test(
                file
            )
    )

    .sort(
        (a, b) => {

            const numberA =
                parseInt(
                    a.match(/\d+/)[0],
                    10
                );

            const numberB =
                parseInt(
                    b.match(/\d+/)[0],
                    10
                );

            return numberA - numberB;

        }
    );

}


function getNextLogNumber() {

    const files =
        getLogFiles();

    if (files.length === 0) {

        return 1;

    }

    const last =
        files[files.length - 1];

    const match =
        last.match(/\d+/);

    return (
        parseInt(
            match[0],
            10
        ) + 1
    );

}


function getCurrentLogFile() {

    const files =
        getLogFiles();

    if (files.length === 0) {

        const file =
            createNewLog(1);

        return file;

    }

    const last =
        files[files.length - 1];

    const fullPath =
        path.join(
            CHAT_LOG_DIR,
            last
        );


    /*
    Vérification de la taille
    */

    const stats =
        fs.statSync(
            fullPath
        );


    if (
        stats.size >=
        CHAT_LOG_LIMIT
    ) {

        const nextNumber =
            getNextLogNumber();

        return createNewLog(
            nextNumber
        );

    }


    return fullPath;

}


function createNewLog(number) {

    const filename =
        `chat-log${String(number).padStart(3, "0")}.json`;

    const filepath =
        path.join(
            CHAT_LOG_DIR,
            filename
        );


    const data = {

        id:
            `chat-log${String(number).padStart(3, "0")}`,

        created:
            getTimestamp(),

        messages: []

    };


    fs.writeFileSync(
        filepath,
        JSON.stringify(
            data,
            null,
            2
        ),
        "utf8"
    );


    console.log(
        `[CHAT] Nouveau log : ${filename}`
    );


    return filepath;

}


function readChatLog(filepath) {

    try {

        const content =
            fs.readFileSync(
                filepath,
                "utf8"
            );

        return JSON.parse(
            content
        );

    }

    catch (error) {

        console.error(
            "[CHAT] Erreur lecture log :",
            error
        );

        return {

            id:
                path.basename(
                    filepath,
                    ".json"
                ),

            created:
                getTimestamp(),

            messages: []

        };

    }

}


function saveChatMessage(message) {

    let filepath =
        getCurrentLogFile();

    let data =
        readChatLog(filepath);


    data.messages.push(
        message
    );


    let serialized =
        JSON.stringify(
            data,
            null,
            2
        );


    /*
    Si le fichier dépasserait
    15 Mo, on crée le suivant
    avant d'y écrire le message.
    */

    if (
        Buffer.byteLength(
            serialized,
            "utf8"
        ) > CHAT_LOG_LIMIT &&
        data.messages.length > 1
    ) {

        const nextNumber =
            getNextLogNumber();

        filepath =
            createNewLog(
                nextNumber
            );

        data =
            readChatLog(filepath);

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


    fs.writeFileSync(
        filepath,
        serialized,
        "utf8"
    );


    return filepath;

}


/*
=========================================================
 UTILISATEURS CONNECTÉS
=========================================================
*/

const users = new Map();


function createUser(ws) {

    let username =
        generateUsername();


    /*
    Évite les doublons
    */

    while (
        [...users.values()]
            .some(
                user =>
                    user.username ===
                    username
            )
    ) {

        username =
            generateUsername();

    }


    const user = {

        id:
            crypto
                .randomBytes(8)
                .toString("hex"),

        username,

        connectedAt:
            getTimestamp(),

        ws

    };


    users.set(
        ws,
        user
    );


    return user;

}


function removeUser(ws) {

    users.delete(ws);

}


/*
=========================================================
 WEBSOCKET
=========================================================
*/

const server =
    http.createServer(
        handleHttpRequest
    );


const wss =
    new WebSocket.Server({
        noServer: true
    });


server.on(
    "upgrade",
    (request, socket, head) => {

        const pathname =
            new URL(
                request.url,
                `http://${request.headers.host}`
            ).pathname;


        if (
            pathname !== "/ws"
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


wss.on(
    "connection",
    ws => {

        const user =
            createUser(ws);


        console.log(
            `[CHAT] ${user.username} connecté`
        );


        send(ws, {

            type:
                "welcome",

            username:
                user.username,

            message:
                `WELCOME ${user.username}`

        });


        broadcast({

            type:
                "system",

            message:
                `${user.username} joined the archive.`

        }, ws);


        broadcastUserCount();


        ws.on(
            "message",
            raw => {

                handleWebSocketMessage(
                    ws,
                    raw
                );

            }
        );


        ws.on(
            "close",
            () => {

                const disconnectedUser =
                    users.get(ws);


                if (
                    disconnectedUser
                ) {

                    console.log(
                        `[CHAT] ${disconnectedUser.username} déconnecté`
                    );


                    broadcast({

                        type:
                            "system",

                        message:
                            `${disconnectedUser.username} left the archive.`

                    }, ws);

                }


                removeUser(ws);

                broadcastUserCount();

            }
        );


        ws.on(
            "error",
            error => {

                console.error(
                    "[WEBSOCKET]",
                    error
                );

            }
        );

    }
);


/*
=========================================================
 WEBSOCKET MESSAGE
=========================================================
*/

function handleWebSocketMessage(
    ws,
    raw
) {

    let data;


    try {

        data =
            JSON.parse(
                raw.toString()
            );

    }

    catch {

        send(ws, {

            type:
                "error",

            message:
                "INVALID JSON"

        });

        return;

    }


    const user =
        users.get(ws);


    if (!user) {

        return;

    }


    /*
    MESSAGE
    */

    if (
        data.type ===
        "message"
    ) {

        const message =
            sanitizeText(
                data.message
            );


        if (!message) {

            return;

        }


        const chatMessage = {

            id:
                crypto
                    .randomBytes(6)
                    .toString("hex"),

            username:
                user.username,

            message,

            timestamp:
                getTimestamp(),

            type:
                "message"

        };


        /*
        Sauvegarde
        */

        saveChatMessage(
            chatMessage
        );


        /*
        Diffusion
        */

        broadcast({

            type:
                "message",

            data:
                chatMessage

        });


        return;

    }


    /*
    CHANGEMENT DE PSEUDO
    */

    if (
        data.type ===
        "username"
    ) {

        const newUsername =
            sanitizeText(
                data.username
            )
            .replace(
                /\s+/g,
                "_"
            )
            .slice(0, 24);


        if (
            !newUsername
        ) {

            return;

        }


        const alreadyUsed =
            [...users.values()]
                .some(
                    other =>
                        other !== user &&
                        other.username
                            .toLowerCase() ===
                        newUsername.toLowerCase()
                );


        if (
            alreadyUsed
        ) {

            send(ws, {

                type:
                    "error",

                message:
                    "USERNAME_ALREADY_USED"

            });

            return;

        }


        const oldUsername =
            user.username;


        user.username =
            newUsername;


        send(ws, {

            type:
                "username",

            username:
                newUsername

        });


        broadcast({

            type:
                "system",

            message:
                `${oldUsername} is now ${newUsername}.`

        });


        return;

    }


    /*
    PING
    */

    if (
        data.type ===
        "ping"
    ) {

        send(ws, {

            type:
                "pong",

            timestamp:
                getTimestamp()

        });

    }

}


/*
=========================================================
 WEBSOCKET UTILITAIRES
=========================================================
*/

function send(
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


function broadcastUserCount() {

    broadcast({

        type:
            "users",

        count:
            users.size

    });

}


/*
=========================================================
 UPLOAD
=========================================================
*/

function getNextMediaNumber(
    directory,
    prefix
) {

    ensureDirectory(
        directory
    );


    const files =
        fs.readdirSync(
            directory
        );


    let highest =
        0;


    for (
        const file of files
    ) {

        const regex =
            new RegExp(
                `^${prefix}(\\d+)\\.`,
                "i"
            );

        const match =
            file.match(regex);


        if (
            match
        ) {

            const number =
                parseInt(
                    match[1],
                    10
                );


            if (
                number > highest
            ) {

                highest =
                    number;

            }

        }

    }


    return highest + 1;

}


function detectUploadType(
    extension
) {

    const ext =
        extension.toLowerCase();


    if (
        IMAGE_EXTENSIONS.includes(ext)
    ) {

        return "picture";

    }


    if (
        MUSIC_EXTENSIONS.includes(ext)
    ) {

        return "music";

    }


    if (
        VIDEO_EXTENSIONS.includes(ext)
    ) {

        return "video";

    }


    return null;

}


function uploadFile(
    request,
    response
) {

    let busboy;


    try {

        busboy =
            Busboy({
                headers:
                    request.headers,

                limits: {
                    fileSize:
                        UPLOAD_LIMIT,

                    files: 1
                }

            });

    }

    catch (error) {

        response.writeHead(
            400,
            {
                "Content-Type":
                    "application/json"
            }
        );

        response.end(
            JSON.stringify({
                error:
                    "Invalid upload."
            })
        );

        return;

    }


    let uploadResult =
        null;

    let uploadError =
        null;


    busboy.on(
        "file",
        (
            fieldname,
            file,
            info
        ) => {

            const originalName =
                sanitizeFilename(
                    info.filename
                );


            const extension =
                path.extname(
                    originalName
                )
                .toLowerCase();


            const type =
                detectUploadType(
                    extension
                );


            if (!type) {

                uploadError =
                    "File type not allowed.";

                file.resume();

                return;

            }


            let directory;
            let prefix;


            if (
                type ===
                "picture"
            ) {

                directory =
                    PICTURE_DIR;

                prefix =
                    "picture";

            }

            else if (
                type ===
                "music"
            ) {

                directory =
                    MUSIC_DIR;

                prefix =
                    "music";

            }

            else {

                directory =
                    VIDEO_DIR;

                prefix =
                    "video";

            }


            const number =
                getNextMediaNumber(
                    directory,
                    prefix
                );


            const filename =
                `${prefix}${String(number).padStart(3, "0")}${extension}`;


            const filepath =
                path.join(
                    directory,
                    filename
                );


            const writeStream =
                fs.createWriteStream(
                    filepath
                );


            let size =
                0;


            file.on(
                "data",
                chunk => {

                    size +=
                        chunk.length;

                }
            );


            file.on(
                "limit",
                () => {

                    uploadError =
                        "File exceeds 25 MB.";

                    writeStream.destroy();

                    fs.rm(
                        filepath,
                        {
                            force: true
                        },
                        () => {}
                    );

                }
            );


            file.pipe(
                writeStream
            );


            writeStream.on(
                "finish",
                () => {

                    if (
                        uploadError
                    ) {

                        return;

                    }


                    uploadResult = {

                        success:
                            true,

                        type,

                        filename,

                        originalName,

                        size,

                        path:
                            type === "picture"
                                ? `/picture/${filename}`
                                : type === "music"
                                    ? `/media/music/${filename}`
                                    : `/media/video/${filename}`

                    };

                }
            );

        }
    );


    busboy.on(
        "finish",
        () => {

            if (
                uploadError
            ) {

                response.writeHead(
                    400,
                    {
                        "Content-Type":
                            "application/json"
                    }
                );

                response.end(
                    JSON.stringify({
                        error:
                            uploadError
                    })
                );

                return;

            }


            if (
                !uploadResult
            ) {

                response.writeHead(
                    400,
                    {
                        "Content-Type":
                            "application/json"
                    }
                );

                response.end(
                    JSON.stringify({
                        error:
                            "No valid file received."
                    })
                );

                return;

            }


            response.writeHead(
                200,
                {
                    "Content-Type":
                        "application/json"
                }
            );


            response.end(
                JSON.stringify(
                    uploadResult
                )
            );


            console.log(
                `[UPLOAD] ${uploadResult.filename} (${uploadResult.size} bytes)`
            );

        }
    );


    request.pipe(
        busboy
    );

}


/*
=========================================================
 HTTP SERVER
=========================================================
*/

function handleHttpRequest(
    request,
    response
) {

    const url =
        new URL(
            request.url,
            `http://${request.headers.host}`
        );


    /*
    HEALTH CHECK
    */

    if (
        url.pathname ===
        "/health"
    ) {

        response.writeHead(
            200,
            {
                "Content-Type":
                    "application/json"
            }
        );


        response.end(
            JSON.stringify({

                status:
                    "online",

                server:
                    "dreamcore",

                uptime:
                    process.uptime(),

                users:
                    users.size,

                time:
                    getTimestamp()

            })
        );


        return;

    }


    /*
    CHAT STATUS
    */

    if (
        url.pathname ===
        "/api/chat/status"
    ) {

        response.writeHead(
            200,
            {
                "Content-Type":
                    "application/json",

                "Access-Control-Allow-Origin":
                    "*"
            }
        );


        response.end(
            JSON.stringify({

                online:
                    true,

                users:
                    users.size,

                logs:
                    getLogFiles().length,

                websocket:
                    "/ws"

            })
        );


        return;

    }


    /*
    UPLOAD
    */

    if (
        url.pathname ===
        "/api/upload"
    ) {

        if (
            request.method !==
            "POST"
        ) {

            response.writeHead(
                405
            );

            response.end();

            return;

        }


        uploadFile(
            request,
            response
        );

        return;

    }


    /*
    CORS PREFLIGHT
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
                    "GET,POST,OPTIONS",

                "Access-Control-Allow-Headers":
                    "Content-Type"
            }
        );

        response.end();

        return;

    }


    /*
    PAGE PRINCIPALE
    */

    if (
        url.pathname ===
        "/"
    ) {

        response.writeHead(
            200,
            {
                "Content-Type":
                    "text/html; charset=utf-8"
            }
        );


        response.end(`
<!DOCTYPE html>

<html lang="fr">

<head>

<meta charset="UTF-8">

<title>DREAMCORE SERVER</title>

<style>

body {
    background:#050505;
    color:#69ff9b;
    font-family:monospace;
    padding:40px;
}

h1 {
    font-size:40px;
}

.box {
    border:1px solid #315c42;
    padding:20px;
    max-width:700px;
}

</style>

</head>

<body>

<div class="box">

<h1>DREAMCORE SERVER</h1>

<p>STATUS: ONLINE</p>

<p>WEBSOCKET: /ws</p>

<p>USERS: ${users.size}</p>

<p>CHAT LOGS: ${getLogFiles().length}</p>

<p>UPLOAD LIMIT: 25 MB</p>

</div>

</body>

</html>
        `);

        return;

    }


    /*
    FICHIER INCONNU
    */

    response.writeHead(
        404,
        {
            "Content-Type":
                "application/json"
        }
    );


    response.end(
        JSON.stringify({

            error:
                "Not found"

        })
    );

}


/*
=========================================================
 DEMARRAGE
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
            " DREAMCORE SERVER"
        );

        console.log(
            "========================================"
        );

        console.log(
            `HTTP : http://localhost:${PORT}`
        );

        console.log(
            `WS   : ws://localhost:${PORT}/ws`
        );

        console.log(
            `CHAT : ${CHAT_LOG_DIR}`
        );

        console.log(
            `IMG  : ${PICTURE_DIR}`
        );

        console.log(
            `MUSIC: ${MUSIC_DIR}`
        );

        console.log(
            `VIDEO: ${VIDEO_DIR}`
        );

        console.log(
            "========================================"
        );

    }
);


/*
=========================================================
 GESTION ARRÊT
=========================================================
*/

function shutdown() {

    console.log(
        "\n[DREAMCORE] Shutdown..."
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
