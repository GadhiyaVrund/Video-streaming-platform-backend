import mongoose, {isValidObjectId} from "mongoose"
import {User} from "../models/user.model.js"
import { Subscription } from "../models/subscription.model.js"
import {ApiError} from "../utils/ApiError.js"
import {ApiResponse} from "../utils/ApiResponse.js"
import {asyncHandler} from "../utils/asyncHandler.js"

const resolveChannelId = (req) => req.params?.channelId || req.params?.subscriberId
const resolveSubscriberId = (req) => req.params?.subscriberId || req.params?.channelId


const toggleSubscription = asyncHandler(async (req, res) => {
    const channelId = resolveChannelId(req)

    if (!isValidObjectId(channelId)) {
        throw new ApiError(400, "Invalid channel ID")
    }

    const subscriberId = req.user?._id
    if (!subscriberId) {
        throw new ApiError(401, "Unauthorized request")
    }

    if (channelId.toString() === subscriberId.toString()) {
        throw new ApiError(400, "You cannot subscribe to your own channel")
    }

    const channelExists = await User.findById(channelId).select("_id")
    if (!channelExists) {
        throw new ApiError(404, "Channel not found")
    }

    const existingSubscription = await Subscription.findOne({
        subscriber: subscriberId,
        channel: channelId
    })

    if (existingSubscription) {
        await Subscription.findByIdAndDelete(existingSubscription._id)
        return res
            .status(200)
            .json(
                new ApiResponse(
                    200,
                    { subscribed: false },
                    "Channel unsubscribed successfully"
                )
            )
    }

    const createdSubscription = await Subscription.create({
        subscriber: subscriberId,
        channel: channelId
    })

    if (!createdSubscription) {
        throw new ApiError(500, "Failed to subscribe channel")
    }

    return res
        .status(201)
        .json(
            new ApiResponse(
                201,
                { subscribed: true },
                "Channel subscribed successfully"
            )
        )
})

// controller to return subscriber list of a channel
const getUserChannelSubscribers = asyncHandler(async (req, res) => {
    const channelId = resolveChannelId(req)

    if (!isValidObjectId(channelId)) {
        throw new ApiError(400, "Invalid channel ID")
    }

    const channelExists = await User.findById(channelId).select("_id")
    if (!channelExists) {
        throw new ApiError(404, "Channel not found")
    }

    const subscribers = await Subscription.aggregate([
        {
            $match: {
                channel: new mongoose.Types.ObjectId(channelId)
            }
        },
        {
            $lookup: {
                from: "users",
                localField: "subscriber",
                foreignField: "_id",
                as: "subscriberDetails",
                pipeline: [
                    {
                        $project: {
                            username: 1,
                            fullName: 1,
                            avatar: 1
                        }
                    }
                ]
            }
        },
        {
            $addFields: {
                subscriberDetails: { $first: "$subscriberDetails" }
            }
        },
        {
            $project: {
                _id: 1,
                subscriber: "$subscriberDetails",
                subscribedAt: "$createdAt"
            }
        },
        {
            $sort: {
                subscribedAt: -1
            }
        }
    ])

    return res
        .status(200)
        .json(
            new ApiResponse(
                200,
                {
                    totalSubscribers: subscribers.length,
                    subscribers
                },
                "Channel subscribers fetched successfully"
            )
        )
})

// controller to return channel list to which user has subscribed
const getSubscribedChannels = asyncHandler(async (req, res) => {
    const subscriberId = resolveSubscriberId(req)

    if (!isValidObjectId(subscriberId)) {
        throw new ApiError(400, "Invalid subscriber ID")
    }

    const subscriberExists = await User.findById(subscriberId).select("_id")
    if (!subscriberExists) {
        throw new ApiError(404, "Subscriber not found")
    }

    const channels = await Subscription.aggregate([
        {
            $match: {
                subscriber: new mongoose.Types.ObjectId(subscriberId)
            }
        },
        {
            $lookup: {
                from: "users",
                localField: "channel",
                foreignField: "_id",
                as: "channelDetails",
                pipeline: [
                    {
                        $lookup: {
                            from: "subscriptions",
                            localField: "_id",
                            foreignField: "channel",
                            as: "channelSubscribers"
                        }
                    },
                    {
                        $addFields: {
                            subscribersCount: { $size: "$channelSubscribers" }
                        }
                    },
                    {
                        $project: {
                            username: 1,
                            fullName: 1,
                            avatar: 1,
                            subscribersCount: 1
                        }
                    }
                ]
            }
        },
        {
            $addFields: {
                channelDetails: { $first: "$channelDetails" }
            }
        },
        {
            $project: {
                _id: 1,
                channel: "$channelDetails",
                subscribedAt: "$createdAt"
            }
        },
        {
            $sort: {
                subscribedAt: -1
            }
        }
    ])

    return res
        .status(200)
        .json(
            new ApiResponse(
                200,
                {
                    totalSubscribedChannels: channels.length,
                    channels
                },
                "Subscribed channels fetched successfully"
            )
        )
})

export {
    toggleSubscription,
    getUserChannelSubscribers,
    getSubscribedChannels
}