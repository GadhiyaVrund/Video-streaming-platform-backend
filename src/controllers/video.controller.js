import mongoose, { isValidObjectId } from "mongoose"
import { Video } from "../models/video.model.js"
import { User } from "../models/user.model.js"
import { ApiError } from "../utils/ApiError.js"
import { ApiResponse } from "../utils/ApiResponse.js"
import { asyncHandler } from "../utils/asyncHandler.js"
import { uploadOnCloudinary, deleteFromCloudinary } from "../utils/cloudinary.js"


// GET /api/v1/videos?page=1&limit=10&query=&sortBy=createdAt&sortType=desc&userId=
const getAllVideos = asyncHandler(async (req, res) => {
    const {
        page = 1,
        limit = 10,
        query,
        sortBy = "createdAt",
        sortType = "desc",
        userId
    } = req.query

    const pipeline = []

    // Full-text search on title / description
    if (query?.trim()) {
        pipeline.push({
            $match: {
                $or: [
                    { title: { $regex: query.trim(), $options: "i" } },
                    { description: { $regex: query.trim(), $options: "i" } }
                ]
            }
        })
    }

    // Filter by a specific owner
    if (userId) {
        if (!isValidObjectId(userId)) {
            throw new ApiError(400, "Invalid userId")
        }
        pipeline.push({
            $match: { owner: new mongoose.Types.ObjectId(userId) }
        })
    }

    // Only return published videos
    pipeline.push({ $match: { isPublished: true } })

    // Join owner info
    pipeline.push(
        {
            $lookup: {
                from: "users",
                localField: "owner",
                foreignField: "_id",
                as: "ownerDetails",
                pipeline: [
                    { $project: { username: 1, avatar: 1, fullName: 1 } }
                ]
            }
        },
        { $unwind: "$ownerDetails" }
    )

    // Sort
    pipeline.push({
        $sort: { [sortBy]: sortType === "asc" ? 1 : -1 }
    })

    const videoAggregate = Video.aggregate(pipeline)

    const options = {
        page: Math.max(1, parseInt(page, 10)),
        limit: Math.min(50, Math.max(1, parseInt(limit, 10)))   // cap at 50
    }

    const videos = await Video.aggregatePaginate(videoAggregate, options)

    return res
        .status(200)
        .json(new ApiResponse(200, videos, "Videos fetched successfully"))
})


// POST /api/v1/videos  (multipart: videoFile, thumbnail)
const publishAVideo = asyncHandler(async (req, res) => {
    const { title, description } = req.body

    if (!title?.trim() || !description?.trim()) {
        throw new ApiError(400, "Title and description are required")
    }

    const videoFileLocalPath = req.files?.videoFile?.[0]?.path
    const thumbnailLocalPath = req.files?.thumbnail?.[0]?.path

    if (!videoFileLocalPath) throw new ApiError(400, "Video file is required")
    if (!thumbnailLocalPath) throw new ApiError(400, "Thumbnail is required")

    const [videoFile, thumbnail] = await Promise.all([
        uploadOnCloudinary(videoFileLocalPath),
        uploadOnCloudinary(thumbnailLocalPath)
    ])

    if (!videoFile?.url) throw new ApiError(500, "Error while uploading video to cloudinary")
    if (!thumbnail?.url) throw new ApiError(500, "Error while uploading thumbnail to cloudinary")

    const video = await Video.create({
        title:       title.trim(),
        description: description.trim(),
        videoFile:   videoFile.url,
        thumbnail:   thumbnail.url,
        duration:    videoFile.duration ?? 0,
        owner:       req.user._id,
        isPublished: true
    })

    if (!video) {
        throw new ApiError(500, "Failed to save video record, please try again")
    }

    return res
        .status(201)
        .json(new ApiResponse(201, video, "Video published successfully"))
})


// GET /api/v1/videos/:videoId
const getVideoById = asyncHandler(async (req, res) => {
    const { videoId } = req.params

    if (!isValidObjectId(videoId)) {
        throw new ApiError(400, "Invalid video ID")
    }

    const video = await Video.aggregate([
        {
            $match: { _id: new mongoose.Types.ObjectId(videoId) }
        },
        // Owner info + subscriber count
        {
            $lookup: {
                from: "users",
                localField: "owner",
                foreignField: "_id",
                as: "owner",
                pipeline: [
                    {
                        $lookup: {
                            from: "subscriptions",
                            localField: "_id",
                            foreignField: "channel",
                            as: "subscribers"
                        }
                    },
                    {
                        $addFields: {
                            subscribersCount: { $size: "$subscribers" },
                            isSubscribed: {
                                $cond: {
                                    if: { $in: [req.user?._id, "$subscribers.subscriber"] },
                                    then: true,
                                    else: false
                                }
                            }
                        }
                    },
                    {
                        $project: {
                            username: 1, fullName: 1, avatar: 1,
                            subscribersCount: 1, isSubscribed: 1
                        }
                    }
                ]
            }
        },
        // Like count
        {
            $lookup: {
                from: "likes",
                localField: "_id",
                foreignField: "video",
                as: "likes"
            }
        },
        {
            $addFields: {
                likesCount: { $size: "$likes" },
                owner: { $first: "$owner" },
                isLiked: {
                    $cond: {
                        if: { $in: [req.user?._id, "$likes.likedBy"] },
                        then: true,
                        else: false
                    }
                }
            }
        },
        {
            $project: {
                videoFile: 1, thumbnail: 1, title: 1, description: 1,
                duration: 1, views: 1, isPublished: 1, createdAt: 1,
                owner: 1, likesCount: 1, isLiked: 1
            }
        }
    ])

    if (!video?.length) {
        throw new ApiError(404, "Video not found")
    }

    // Increment view count and add to watch history (fire-and-forget, non-blocking)
    await Promise.all([
        Video.findByIdAndUpdate(videoId, { $inc: { views: 1 } }),
        User.findByIdAndUpdate(req.user?._id, { $addToSet: { watchHistory: videoId } })
    ])

    return res
        .status(200)
        .json(new ApiResponse(200, video[0], "Video fetched successfully"))
})


// PATCH /api/v1/videos/:videoId  (multipart: optional thumbnail)
const updateVideo = asyncHandler(async (req, res) => {
    const { videoId } = req.params
    const { title, description } = req.body

    if (!isValidObjectId(videoId)) {
        throw new ApiError(400, "Invalid video ID")
    }

    if (!title?.trim() && !description?.trim() && !req.file) {
        throw new ApiError(400, "At least one field (title, description, thumbnail) is required to update")
    }

    const video = await Video.findById(videoId)
    if (!video) throw new ApiError(404, "Video not found")

    if (video.owner.toString() !== req.user._id.toString()) {
        throw new ApiError(403, "You are not authorized to update this video")
    }

    let thumbnailUrl = video.thumbnail
    let oldThumbnailPublicId = null

    if (req.file) {
        // Extract cloudinary public_id from existing thumbnail URL
        const urlSegments = video.thumbnail?.split("/")
        if (urlSegments?.length) {
            oldThumbnailPublicId = urlSegments.pop().split(".")[0]
        }

        const newThumbnail = await uploadOnCloudinary(req.file.path)
        if (!newThumbnail?.url) {
            throw new ApiError(500, "Error while uploading new thumbnail")
        }
        thumbnailUrl = newThumbnail.url
    }

    const updatedVideo = await Video.findByIdAndUpdate(
        videoId,
        {
            $set: {
                title:       title?.trim()       || video.title,
                description: description?.trim() || video.description,
                thumbnail:   thumbnailUrl
            }
        },
        { new: true }
    )

    if (!updatedVideo) {
        throw new ApiError(500, "Failed to update video, please try again")
    }

    // Remove old thumbnail from cloudinary only after a successful DB write
    if (oldThumbnailPublicId) {
        await deleteFromCloudinary(oldThumbnailPublicId, "image")
    }

    return res
        .status(200)
        .json(new ApiResponse(200, updatedVideo, "Video updated successfully"))
})


// DELETE /api/v1/videos/:videoId
const deleteVideo = asyncHandler(async (req, res) => {
    const { videoId } = req.params

    if (!isValidObjectId(videoId)) {
        throw new ApiError(400, "Invalid video ID")
    }

    const video = await Video.findById(videoId)
    if (!video) throw new ApiError(404, "Video not found")

    if (video.owner.toString() !== req.user._id.toString()) {
        throw new ApiError(403, "You are not authorized to delete this video")
    }

    await Video.findByIdAndDelete(videoId)

    // Extract public IDs and clean up cloudinary assets
    const videoPublicId    = video.videoFile?.split("/").pop().split(".")[0]
    const thumbnailPublicId = video.thumbnail?.split("/").pop().split(".")[0]

    await Promise.all([
        deleteFromCloudinary(videoPublicId, "video"),
        deleteFromCloudinary(thumbnailPublicId, "image")
    ])

    return res
        .status(200)
        .json(new ApiResponse(200, {}, "Video deleted successfully"))
})


// PATCH /api/v1/videos/toggle/publish/:videoId
const togglePublishStatus = asyncHandler(async (req, res) => {
    const { videoId } = req.params

    if (!isValidObjectId(videoId)) {
        throw new ApiError(400, "Invalid video ID")
    }

    const video = await Video.findById(videoId)
    if (!video) throw new ApiError(404, "Video not found")

    if (video.owner.toString() !== req.user._id.toString()) {
        throw new ApiError(403, "You are not authorized to change the publish status of this video")
    }

    const updatedVideo = await Video.findByIdAndUpdate(
        videoId,
        { $set: { isPublished: !video.isPublished } },
        { new: true }
    )

    if (!updatedVideo) {
        throw new ApiError(500, "Failed to toggle publish status, please try again")
    }

    return res
        .status(200)
        .json(
            new ApiResponse(
                200,
                { isPublished: updatedVideo.isPublished },
                `Video ${updatedVideo.isPublished ? "published" : "unpublished"} successfully`
            )
        )
})


export {
    getAllVideos,
    publishAVideo,
    getVideoById,
    updateVideo,
    deleteVideo,
    togglePublishStatus
}
