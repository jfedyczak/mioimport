"use strict";

const fs = require('fs')
const path = require('path')
const child_process = require('child_process')

const CARD_DIR = '/Volumes/NO NAME'
const DEVICE_FILE = `${CARD_DIR}/Device.xml`
const PREFIX_LIST = ['Event', 'Parking', 'Photo', 'Video']

const dateISO = (date) => {
	let y = `${date.getFullYear()}`
	while (y.length < 4) y = `0${y}`
	let m = `${date.getMonth() + 1}`
	while (y.length < 2) m = `0${y}`
	let d = `${date.getDate()}`
	while (d.length < 2) d = `0${d}`
	return `${y}-${m}-${d}`
}

const Promise_serial = (list) => {
	let res = []
	let doNext = () => {
		if (!list.length) return Promise.resolve()
		let p = list.shift()
		return p().then((w) => {
			res.push(w)
			return doNext()
		})
	}
	return doNext().then(() => res)
}

const createIfNotExists = (dirName) => {
	return new Promise((resolve, reject) => {
		fs.stat(dirName, (err) => {
			if (err) {
				console.log(` -- creating ${dirName}`)
				fs.mkdir(dirName, (err) => {
					if (err) return reject()
					resolve()
				})
			} else {
				resolve()
			}
		})
	})
}

const readDeviceData = () => {
	return new Promise((resolve, reject) => {
		fs.readFile(DEVICE_FILE, 'utf8', (err, data) => {
			if (err) return reject(`can't read Device.xml`)
			let deviceName = /<ProductName>([^<]+)<\/ProductName>/.exec(data)
			if (!deviceName) return reject(`can't read ProductName`)
			resolve(deviceName[1])
		})
	})
}

const copyFile = (src, dst) => {
	return new Promise((resolve, reject) => {
		let rs = fs.createReadStream(src)
		let ws = fs.createWriteStream(dst)
		rs.on('error', (err) => {
			reject(err)
		})
		ws.on('error', (err) => {
			reject(err)
		})
		ws.on('close', (err) => {
			resolve()
		})
		rs.pipe(ws)
	})
}

const renameFile = (src, dst) => {
	return new Promise((resolve, reject) => {
		fs.rename(src, dst, (err) => {
			if (err) return reject(err)
			resolve()
		})
	})
}

const setUtime = (file, atime, mtime) => {
	return new Promise((resolve, reject) => {
		fs.utimes(file, atime, mtime, (err) => {
			if (err) return reject(err)
			resolve()
		})
	})
}

const safeCopyFile = (src, dst) => {
	let tmpFile = `${dst}-temp`
	return copyFile(src, tmpFile)
	.then(() => {
		return renameFile(tmpFile, dst)
	})
}

const listFiles = (prefix, targetDir) => {
	return new Promise((resolve, reject) => {
		fs.readdir(`${CARD_DIR}/${prefix}`, (err, list) => {
			if (err) return reject(err)
			list = list
				.filter((name) => /\.(LOG|MP4|JPG)$/.test(name))
				.map((name) => {
					return {
						fileName: name,
						prefix: prefix,
						sourceFile: `${CARD_DIR}/${prefix}/${name}`
					}
				})
				.map((fileData) => {
					return () => {
						return new Promise((resolve, reject) => {
							fs.stat(fileData.sourceFile, (err, stat) => {
								if (err) return reject(err)
								fileData.mtime = +stat.mtime / 1000
								fileData.atime = +stat.atime / 1000
								fileData.day = dateISO(stat.mtime)
								fileData.size = +stat.size
								resolve(fileData)
							})
						})
					}
				})
			resolve(Promise_serial(list))
		})
	})
	.then((list) => {
		return list.map((fileData) => {
			fileData.destDir = `${targetDir}/${fileData.day}`
			fileData.destDirEvent = `${fileData.destDir}/${fileData.prefix}`
			fileData.destFile = `${fileData.destDirEvent}/${fileData.fileName}`
			return fileData
		})
	})
	.then((list) => {
		return Promise_serial(list.map((fileData) => {
			return () => {
				return new Promise((resolve, reject) => {
					fs.stat(fileData.destFile, (err, stat) => {
						fileData.fileExist = !err
						resolve(fileData)
					})
				})
			}
		}))
	})
	.then((list) => {
		return list.filter((fileData) => !fileData.fileExist)
	})
}

let processFile = (fileData) => {
	return createIfNotExists(fileData.destDir)
	.then(() => createIfNotExists(fileData.destDirEvent))
	.then(() => {
		return safeCopyFile(fileData.sourceFile, fileData.destFile)
	})
	.then(() => {
		return setUtime(fileData.destFile, fileData.atime, fileData.mtime)
	})
}

if (process.argv.length < 3) {
	console.log("Usage: node mioimport.js <target_dir>")
	process.exit(1)
}

let WORKING_DIR = path.resolve(process.argv[2])

let TOTAL_SIZE = 0
let FILES_LEFT = 0
let PROCESSED_SIZE = 0

createIfNotExists(WORKING_DIR)
.then(readDeviceData)
.then((deviceName) => {
	console.log(` -- got device name: ${deviceName}`)
	return Promise_serial(PREFIX_LIST.map((prefix) => () => listFiles(prefix, WORKING_DIR)))
})
.then((lista) => {
	lista = [].concat.apply([], lista)
	lista.sort((a, b) => a.mtime - b.mtime)
	TOTAL_SIZE = lista.reduce((suma, plik) => {return suma + plik.size}, 0)
	FILES_LEFT = lista.length
	return Promise_serial(lista.map((fileData) => {
		return () => {
			return processFile(fileData)
			.then(() => {
				PROCESSED_SIZE += fileData.size
				FILES_LEFT -= 1
				console.log(` -- progress: ${Math.round(PROCESSED_SIZE * 100 / TOTAL_SIZE)}% / files: ${FILES_LEFT} / size: ${Math.round((TOTAL_SIZE - PROCESSED_SIZE) / 1024 / 1024)} MiB`)
			})
		}
	}))
})
.then(() => {
	return new Promise((resolve, reject) => {
		console.log(' -- ejecting disk')
		child_process.execFile('diskutil', ['eject', CARD_DIR], (err) => {
			if (err) throw err
			resolve()
		})
	})
})
.then(() => {
	console.log(' -- done')
})
.catch((e) => {
	console.log(` -- error: ${e}`)
})
